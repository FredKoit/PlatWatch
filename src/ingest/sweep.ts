import type { Db } from "../db/index";
import { finishSweep, startSweep } from "../db/index";
import {
  insertSnapshots,
  markLeftTop,
  recordOrders,
  summariseByVariant,
  type SnapshotRow,
} from "../db/repo";
import { getTopOrders } from "../wfm/client";
import { WfmEndpointRetiredError, WfmError, WfmUnavailableError } from "../wfm/errors";
import type { TopOrders, WfmOrder } from "../wfm/types";
import type { ItemRow } from "./details";

/** Flush size. Large enough that fsync is amortised, small enough to lose little. */
const BATCH = 200;

/**
 * Failures in a row that mean warframe.market is unreachable, not that a few
 * items are odd. Each one has already been retried four times with backoff.
 *
 * Without this, an outage ground through the whole catalogue — about 5.6s of
 * retries per item, some six hours — and then stamped the empty result as a
 * finished full sweep. That became "the market": the ranking emptied, the
 * sniper lost every baseline, and nothing said why. A 403 counts too: it is as
 * likely a block as a retired route, and hammering a block is the worst reply.
 */
export const MAX_CONSECUTIVE_OUTAGE_FAILURES = 10;

/**
 * Below this share of the catalogue fetched, a sweep that ran to the end is
 * recorded as partial. Healthy sweeps reach ~100%; one that lost a stretch of
 * the market to a flaky network would otherwise silently drop those items from
 * the ranking until the next sweep.
 */
export const MIN_BASELINE_COVERAGE = 0.9;

const isOutage = (err: unknown): boolean =>
  err instanceof WfmUnavailableError || err instanceof WfmEndpointRetiredError;

export interface SweepProgress {
  (done: number, total: number, ok: number, failed: number): void;
}

export interface SweepResult {
  sweepId: number;
  ok: number;
  failed: number;
  withOrders: number;
  elapsedMs: number;
  /** True if the run stopped early (interrupt, abort, or an outage). */
  interrupted: boolean;
  /** Set when it stopped because warframe.market stopped answering. */
  stoppedBy?: "unreachable";
  /** Set when it ran to the end but covered too little to be the baseline. */
  partial?: boolean;
}

export function itemsToSweep(db: Db): ItemRow[] {
  return db
    .prepare("SELECT id, slug, name, tags FROM item ORDER BY slug")
    .all() as ItemRow[];
}

/**
 * Walk the catalogue recording top-of-book for every item.
 *
 * At 3 req/s this is roughly 21 minutes for the full catalogue. It is a
 * baseline job, not something to run per page load — the live path is
 * /v2/orders/recent, which covers ~313 items in a single request.
 *
 * Resumable: snapshot has a unique (item_id, sweep_id), and passing an existing
 * `sweepId` skips items already recorded under it.
 */
export async function sweepTopOrders(
  db: Db,
  items: ItemRow[],
  opts: {
    sweepId?: number;
    onProgress?: SweepProgress;
    signal?: AbortSignal;
    /** Watchlist refreshes outrank the nightly crawl. See PRIORITY. */
    priority?: number;
    /** Injectable for tests; defaults to /v2/orders/item/{slug}/top. */
    fetchTop?: (slug: string, signal?: AbortSignal) => Promise<TopOrders>;
  } = {},
): Promise<SweepResult> {
  const startedAt = Date.now();
  const sweepId = opts.sweepId ?? startSweep(db, "top");
  const fetchTop =
    opts.fetchTop ?? ((slug: string, signal?: AbortSignal) => getTopOrders(slug, signal, opts.priority));

  const alreadyDone = new Set(
    (
      db
        .prepare("SELECT item_id FROM snapshot WHERE sweep_id = ?")
        .all(sweepId) as Array<{ item_id: string }>
    ).map((r) => r.item_id),
  );

  let ok = 0;
  let failed = 0;
  let withOrders = 0;
  let interrupted = false;
  let stoppedBy: SweepResult["stoppedBy"];
  let outageRun = 0;

  let snapBuffer: SnapshotRow[] = [];
  let orderBuffer: Array<{ order: WfmOrder; rank: number }> = [];

  const flush = () => {
    if (snapBuffer.length) insertSnapshots(db, sweepId, snapBuffer);
    if (orderBuffer.length) recordOrders(db, orderBuffer);
    snapBuffer = [];
    orderBuffer = [];
  };

  for (const [i, item] of items.entries()) {
    if (opts.signal?.aborted) {
      interrupted = true;
      break;
    }
    if (alreadyDone.has(item.id)) {
      ok++;
      continue;
    }

    try {
      const top = await fetchTop(item.slug, opts.signal);
      outageRun = 0;
      snapBuffer.push(...summariseByVariant(item.id, top));

      const present: string[] = [];
      top.sell.forEach((order, rank) => {
        orderBuffer.push({ order, rank });
        present.push(order.id);
      });
      top.buy.forEach((order, rank) => {
        orderBuffer.push({ order, rank });
        present.push(order.id);
      });

      // Only touches rows written by earlier sweeps: this item's orders are
      // still buffered, and the ones still on the book are excluded by id.
      markLeftTop(db, item.id, present);

      if (top.sell.length || top.buy.length) withOrders++;
      ok++;
    } catch (err) {
      failed++;
      if (!(err instanceof WfmError)) {
        flush();
        throw err;
      }
      // A 404 is one odd item; only an unbroken run of outages stops the sweep.
      outageRun = isOutage(err) ? outageRun + 1 : 0;
      if (outageRun >= MAX_CONSECUTIVE_OUTAGE_FAILURES) {
        interrupted = true;
        stoppedBy = "unreachable";
        break;
      }
    }

    if (snapBuffer.length >= BATCH) flush();
    opts.onProgress?.(i + 1, items.length, ok, failed);
  }

  flush();
  // Leave `finished_at` NULL when we stopped early, so --resume can find this
  // sweep and continue it. Stamping it here would make a clean Ctrl-C *worse*
  // than pulling the power: the interrupted run would look complete. The same
  // goes for an outage: the previous baseline stays until the market answers.
  const partial = !interrupted && ok < items.length * MIN_BASELINE_COVERAGE;
  if (!interrupted) finishSweep(db, sweepId, ok, failed, partial ? "partial" : undefined);

  return {
    sweepId,
    ok,
    failed,
    withOrders,
    elapsedMs: Date.now() - startedAt,
    interrupted,
    ...(stoppedBy ? { stoppedBy } : {}),
    ...(partial ? { partial } : {}),
  };
}
