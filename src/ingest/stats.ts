import type { Db } from "../db/index";
import { statistics } from "../wfm/statistics";
import { WfmError } from "../wfm/errors";
import type { ItemStatistics, StatBucket } from "../wfm/types";
import { statVariantKey } from "../wfm/types";
import type { ItemRow } from "./details";
import { DAILY_PERIOD_MS, HOURLY_PERIOD_MS, periodEnd } from "../rank/freshness";

/**
 * Price history ingestion.
 *
 * One request per item at roughly 100 KB each, so this is deliberately run
 * over candidates rather than the whole catalogue: an item with no live
 * order book cannot be ranked whatever its history says.
 */

export interface StatsProgress {
  (done: number, total: number, ok: number, failed: number): void;
}

/**
 * Items worth pricing history for.
 *
 * Deliberately broad: splitting books by variant leaves most of them one-sided
 * (2,632 ask-only and 486 bid-only rows against 1,634 two-sided), and a bid-only
 * variant like a rank-10 mod can NEVER show an ask in /top — the five cheapest
 * asks are always the lowest rank. History is the only way to price those.
 */
export function statsCandidates(db: Db, sweepId: number): ItemRow[] {
  return db
    .prepare(
      `SELECT DISTINCT i.id, i.slug, i.name, i.tags
         FROM snapshot s
         JOIN item i ON i.id = s.item_id
        WHERE s.sweep_id = @sweep
          AND (
                s.low_sell IS NOT NULL
             OR s.high_buy IS NOT NULL
             OR i.set_root = 1
             OR i.id IN (SELECT part_id FROM item_part)
          )
        ORDER BY i.slug`,
    )
    .all({ sweep: sweepId }) as ItemRow[];
}

const dayOf = (iso: string): string => iso.slice(0, 10);

export interface Summary {
  volume48h: number;
  volume7d: number;
  volume30d: number;
  median7d: number | null;
  median30d: number | null;
  /** Distinct days that saw a trade within the last 30 CALENDAR days. */
  daysTraded30d: number;
  /** Most recent day with any trade, or null if the item has no history. */
  lastTradedDay: string | null;
  /**
   * When the most recent trade had happened by — the END of the newest bucket.
   * Taken from the hourly series when there is one, because the daily series
   * only covers closed days and is always at least a day behind. See
   * rank/freshness.ts for why that distinction emptied the ranking.
   */
  lastTradedAt: string | null;
}

/** Volume-weighted median is overkill here; the daily median of medians is enough. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * One summary per variant series.
 *
 * Statistics come back as interleaved series — a mod returns a rank-0 bucket
 * and a rank-10 bucket for the same day, with different volumes and medians.
 * Summarising them together prices a good that does not exist, and storing them
 * under one key silently drops whichever was written first.
 */
export function summariseByVariant(
  stats: ItemStatistics,
  now = Date.now(),
): Map<string, Summary> {
  const series = new Map<string, { daily: StatBucket[]; hourly: StatBucket[] }>();
  const bucket = (key: string) => {
    let s = series.get(key);
    if (!s) {
      s = { daily: [], hourly: [] };
      series.set(key, s);
    }
    return s;
  };
  for (const b of stats.daily) bucket(statVariantKey(b)).daily.push(b);
  for (const b of stats.hourly) bucket(statVariantKey(b)).hourly.push(b);

  const out = new Map<string, Summary>();
  for (const [variant, s] of series) {
    // The API OMITS buckets for periods with no trades rather than zero-filling
    // them. Slicing the last N buckets therefore spans far more than N days on
    // an illiquid item and overstates volume — window by date instead.
    const within = (days: number) =>
      s.daily.filter((b) => Date.parse(b.datetime) >= now - days * 86_400_000);

    const last7 = within(7);
    const last30 = within(30);
    const sum = (bs: StatBucket[]) => bs.reduce((n, b) => n + b.volume, 0);

    // Newest by timestamp rather than by array position: the series is
    // oldest-first in practice, but nothing in the API promises that.
    const newest = (bs: StatBucket[]) =>
      bs.reduce<StatBucket | null>(
        (best, b) => (best === null || Date.parse(b.datetime) > Date.parse(best.datetime) ? b : best),
        null,
      );
    const newestHourly = newest(s.hourly);
    const newestDaily = newest(s.daily);

    out.set(variant, {
      volume48h: sum(s.hourly),
      volume7d: sum(last7),
      volume30d: sum(last30),
      median7d: medianOf(last7.map((b) => b.median)),
      median30d: medianOf(last30.map((b) => b.median)),
      daysTraded30d: new Set(last30.map((b) => b.datetime.slice(0, 10))).size,
      lastTradedDay: s.daily.at(-1)?.datetime.slice(0, 10) ?? null,
      lastTradedAt: newestHourly
        ? periodEnd(newestHourly.datetime, HOURLY_PERIOD_MS)
        : newestDaily
          ? periodEnd(newestDaily.datetime, DAILY_PERIOD_MS)
          : null,
    });
  }
  return out;
}

export function saveStats(db: Db, itemId: string, stats: ItemStatistics): Map<string, Summary> {
  const summaries = summariseByVariant(stats);

  const daily = db.prepare(
    `INSERT INTO stat_daily (item_id, day, variant, volume, median, avg_price, min_price, max_price)
     VALUES (@item_id, @day, @variant, @volume, @median, @avg_price, @min_price, @max_price)
     ON CONFLICT(item_id, day, variant) DO UPDATE SET
       volume = excluded.volume,
       median = excluded.median,
       avg_price = excluded.avg_price,
       min_price = excluded.min_price,
       max_price = excluded.max_price`,
  );
  const summaryStmt = db.prepare(
    `INSERT INTO stat_summary
       (item_id, variant, fetched_at, volume_48h, volume_7d, volume_30d,
        median_7d, median_30d, days_traded_30d, last_traded_day, last_traded_at)
     VALUES (@item_id, @variant, @fetched_at, @v48, @v7, @v30, @m7, @m30, @days, @last_day,
             @last_at)
     ON CONFLICT(item_id, variant) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       volume_48h = excluded.volume_48h,
       volume_7d = excluded.volume_7d,
       volume_30d = excluded.volume_30d,
       median_7d = excluded.median_7d,
       median_30d = excluded.median_30d,
       days_traded_30d = excluded.days_traded_30d,
       last_traded_day = excluded.last_traded_day,
       last_traded_at = excluded.last_traded_at`,
  );

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const b of stats.daily) {
      daily.run({
        item_id: itemId,
        day: dayOf(b.datetime),
        variant: statVariantKey(b),
        volume: b.volume,
        median: b.median,
        avg_price: b.avg_price,
        min_price: b.min_price,
        max_price: b.max_price,
      });
    }
    for (const [variant, summary] of summaries) {
      summaryStmt.run({
        item_id: itemId,
        variant,
        fetched_at: now,
        v48: summary.volume48h,
        v7: summary.volume7d,
        v30: summary.volume30d,
        m7: summary.median7d,
        m30: summary.median30d,
        days: summary.daysTraded30d,
        last_day: summary.lastTradedDay,
        last_at: summary.lastTradedAt,
      });
    }
  })();

  return summaries;
}

export interface StatsResult {
  ok: number;
  failed: number;
  skipped: number;
  interrupted: boolean;
}

/**
 * Fetch and store history for each candidate.
 *
 * `maxAgeHours` skips items whose summary is already recent, so a re-run after
 * an interruption costs only what it still needs.
 */
export async function ingestStats(
  db: Db,
  items: ItemRow[],
  opts: {
    onProgress?: StatsProgress;
    signal?: AbortSignal;
    maxAgeHours?: number;
    concurrency?: number;
  } = {},
): Promise<StatsResult> {
  const maxAge = (opts.maxAgeHours ?? 20) * 3_600_000;
  const fresh = new Set(
    (
      db
        .prepare("SELECT DISTINCT item_id, fetched_at FROM stat_summary")
        .all() as Array<{ item_id: string; fetched_at: string }>
    )
      .filter((r) => Date.now() - Date.parse(r.fetched_at) < maxAge)
      .map((r) => r.item_id),
  );

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let done = 0;
  let interrupted = false;

  const pending = items.filter((i) => !fresh.has(i.id));
  skipped = items.length - pending.length;

  // Statistics responses are ~100 KB, so a sequential loop sits at ~1 req/s and
  // leaves two thirds of the rate budget unused. The limiter is global and
  // enforces the real ceiling, so overlapping requests is safe — the pool only
  // decides how many are allowed to be waiting on the network at once.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) {
        interrupted = true;
        return;
      }
      const index = cursor++;
      const item = pending[index];
      if (!item) return;

      try {
        const stats = await statistics.getStatistics(item.slug, opts.signal);
        // better-sqlite3 is synchronous, so this write cannot interleave with
        // another worker's write mid-transaction.
        saveStats(db, item.id, stats);
        ok++;
      } catch (err) {
        failed++;
        if (!(err instanceof WfmError)) throw err;
      }
      opts.onProgress?.(++done, pending.length, ok, failed);
    }
  };

  const lanes = Math.max(1, opts.concurrency ?? 3);
  await Promise.all(Array.from({ length: lanes }, worker));

  return { ok, failed, skipped, interrupted };
}
