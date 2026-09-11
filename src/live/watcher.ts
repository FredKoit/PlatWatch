import type { Db } from "../db/index";
import { recordOrders } from "../db/repo";
import { getRecentOrders } from "../wfm/client";
import { WfmError } from "../wfm/errors";
import type { WfmOrder } from "../wfm/types";
import { variantKey } from "../wfm/types";
import { DEFAULT_ALERT_POLICY, detect, type Alert, type AlertPolicy, type Baseline } from "./detect";
import { applyLiveOrders, LIVE_OVERLAY, liveCutoff } from "./book";
import { latestSweepId } from "../rank/query";

/**
 * The live layer.
 *
 * /v2/orders/recent returns every order posted market-wide in roughly the last
 * ten minutes — about 384 orders across 313 items — for ONE request. Sweeping
 * those items individually would cost 313. This is the whole reason the live
 * path can run continuously while the baseline sweep runs nightly.
 *
 * The window is bounded by count as well as time, so it SHRINKS when the market
 * is busy. Poll well inside it.
 */

export const DEFAULT_POLL_MS = 90_000;

/**
 * Baselines for every priced market, keyed by item AND variant.
 *
 * The live book overlays the sweep here too, so an ask seen minutes ago beats
 * one recorded at the start of a 22-minute crawl.
 */
export function loadBaselines(db: Db, sweepId: number): Map<string, Baseline> {
  const rows = db
    .prepare(
      `SELECT i.id AS itemId, i.slug, i.name,
              s.variant AS variant,
              s.sell_p50_top AS fairValue,
              ${LIVE_OVERLAY.lowSell} AS lowSell,
              ${LIVE_OVERLAY.liveAt}  AS liveAt,
              s.taken_at AS snapshotAt,
              ss.volume_48h AS volume48h, ss.last_traded_day AS lastTradedDay,
              ss.last_traded_at AS lastTradedAt,
              ss.median_7d AS median7d
         FROM snapshot s
         JOIN item i ON i.id = s.item_id
         LEFT JOIN stat_summary ss ON ss.item_id = s.item_id AND ss.variant = s.variant
         LEFT JOIN live_book lb ON lb.item_id = s.item_id AND lb.variant = s.variant
        WHERE s.sweep_id = @sweep`,
    )
    .all({ sweep: sweepId, liveCutoff: liveCutoff() }) as Baseline[];
  // Keyed by item AND variant: a rank-0 price says nothing about rank 10.
  return new Map(rows.map((r) => [`${r.itemId}|${r.variant}`, r]));
}

/** Persist a fired alert. The unique index makes re-polling harmless. */
function saveAlert(db: Db, alert: Alert): boolean {
  const info = db
    .prepare(
      `INSERT INTO alert
         (order_id, item_id, variant, kind, platinum, reference, profit, volume_48h,
          ingame_name, user_status, baseline_age_h, suspicious, fired_at)
       VALUES (@orderId, @itemId, @variant, @kind, @platinum, @reference, @profit, @volume48h,
               @ingameName, @userStatus, @baselineAgeH, @suspiciousFlag, @firedAt)
       ON CONFLICT(order_id, kind) DO NOTHING`,
    )
    .run({
      ...alert,
      suspiciousFlag: alert.suspicious ? 1 : 0,
      firedAt: new Date().toISOString(),
    });
  return info.changes > 0;
}

export interface WatchStats {
  polls: number;
  ordersSeen: number;
  newOrders: number;
  /** Prices improved on the live book — the coverage the sweep cannot give. */
  liveUpdates: number;
  alerts: number;
  errors: number;
  /** The sweep alerts are currently judged against. */
  baselineSweepId: number | null;
}

export interface WatchOptions {
  /**
   * Which sweep to judge orders against. Resolved on EVERY reload, never once.
   *
   * The sniper used to take a fixed sweep id at startup and keep it for its
   * whole life, so it ignored every sweep that completed afterwards. Worse,
   * detect() suppresses alerts once the baseline is older than
   * maxBaselineAgeH — so about a day and a half after that first sweep, every
   * alert stopped, with no error and nothing in the log to say why.
   *
   * Defaults to the latest sweep: the same baseline the ranking uses, so the
   * two cannot disagree about what the market looks like.
   */
  baselineSweep?: () => number | null;
  /** Injectable for tests; defaults to the live /v2/orders/recent feed. */
  fetchRecent?: (signal?: AbortSignal) => Promise<WfmOrder[]>;
  /** Called when newer sweep data replaces the baseline. */
  onBaselineChange?: (sweepId: number) => void;
  pollMs?: number;
  policy?: AlertPolicy;
  signal?: AbortSignal;
  onAlert: (alert: Alert) => void | Promise<void>;
  onPoll?: (batch: { total: number; fresh: number; alerts: number }, stats: WatchStats) => void;
  onError?: (err: unknown) => void;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Poll until aborted.
 *
 * Every order seen is written to order_seen whether or not it alerts — the live
 * feed is a far better source of first_seen than the nightly sweep, and that
 * timestamp is what reachability scoring is eventually built on.
 */
export async function watch(db: Db, opts: WatchOptions): Promise<WatchStats> {
  const policy = opts.policy ?? DEFAULT_ALERT_POLICY;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const resolveSweep = opts.baselineSweep ?? (() => latestSweepId(db));
  const fetchRecent = opts.fetchRecent ?? getRecentOrders;

  let sweepId = resolveSweep();
  let baselines: Map<string, Baseline> =
    sweepId === null ? new Map() : loadBaselines(db, sweepId);

  const stats: WatchStats = {
    polls: 0,
    ordersSeen: 0,
    newOrders: 0,
    liveUpdates: 0,
    alerts: 0,
    errors: 0,
    baselineSweepId: sweepId,
  };
  // The API window holds a few hundred orders; keep a generous multiple so an
  // order cannot fall out of memory and be re-reported as new.
  const seen = new Set<string>();
  const SEEN_CAP = 5000;

  while (!opts.signal?.aborted) {
    let orders: WfmOrder[] = [];
    try {
      orders = await fetchRecent(opts.signal);
      stats.polls++;
    } catch (err) {
      stats.errors++;
      opts.onError?.(err);
      if (!(err instanceof WfmError)) throw err;
      await sleep(pollMs, opts.signal);
      continue;
    }

    stats.ordersSeen += orders.length;
    const fresh = orders.filter((o) => !seen.has(o.id));
    for (const o of fresh) seen.add(o.id);

    if (seen.size > SEEN_CAP) {
      // Cheapest correct eviction: drop the oldest half in insertion order.
      const keep = [...seen].slice(-Math.floor(SEEN_CAP / 2));
      seen.clear();
      for (const id of keep) seen.add(id);
    }

    // rank 0: these are freshly posted, not observed positions on a book.
    if (fresh.length) {
      recordOrders(db, fresh.map((order) => ({ order, rank: 0 })));
      // Fold them into the live book BEFORE detecting, then reload. An order
      // cannot trigger on itself — a new ask moves low_sell while a sell is
      // judged against the median — but a cheap ask posted seconds earlier in
      // the same batch legitimately makes a following bid profitable.
      stats.liveUpdates += applyLiveOrders(db, fresh);

      // Re-resolve rather than reuse: a sweep may have finished since the last
      // poll, and judging against the old one is how alerts used to go silent.
      const next = resolveSweep();
      if (next !== null) {
        if (next !== sweepId) {
          sweepId = next;
          stats.baselineSweepId = next;
          opts.onBaselineChange?.(next);
        }
        baselines = loadBaselines(db, sweepId);
      }
    }
    stats.newOrders += fresh.length;

    let fired = 0;
    for (const order of fresh) {
      const alert = detect(order, baselines.get(`${order.itemId}|${variantKey(order)}`), policy);
      if (!alert) continue;
      if (!saveAlert(db, alert)) continue; // already reported
      stats.alerts++;
      fired++;
      await opts.onAlert(alert);
    }

    opts.onPoll?.({ total: orders.length, fresh: fresh.length, alerts: fired }, stats);
    await sleep(pollMs, opts.signal);
  }

  return stats;
}
