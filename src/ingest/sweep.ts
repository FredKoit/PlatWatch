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
import { WfmError } from "../wfm/errors";
import type { WfmOrder } from "../wfm/types";
import type { ItemRow } from "./details";

/** Flush size. Large enough that fsync is amortised, small enough to lose little. */
const BATCH = 200;

export interface SweepProgress {
  (done: number, total: number, ok: number, failed: number): void;
}

export interface SweepResult {
  sweepId: number;
  ok: number;
  failed: number;
  withOrders: number;
  elapsedMs: number;
  /** True if the run stopped early (interrupt or abort). */
  interrupted: boolean;
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
  } = {},
): Promise<SweepResult> {
  const startedAt = Date.now();
  const sweepId = opts.sweepId ?? startSweep(db, "top");

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
      const top = await getTopOrders(item.slug, opts.signal, opts.priority);
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
    }

    if (snapBuffer.length >= BATCH) flush();
    opts.onProgress?.(i + 1, items.length, ok, failed);
  }

  flush();
  // Leave `finished_at` NULL when we stopped early, so --resume can find this
  // sweep and continue it. Stamping it here would make a clean Ctrl-C *worse*
  // than pulling the power: the interrupted run would look complete.
  if (!interrupted) finishSweep(db, sweepId, ok, failed);

  return {
    sweepId,
    ok,
    failed,
    withOrders,
    elapsedMs: Date.now() - startedAt,
    interrupted,
  };
}
