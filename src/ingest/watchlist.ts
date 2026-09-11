import type { Db } from "../db/index";
import { markLeftTop, recordOrders } from "../db/repo";
import { applyLiveOrders } from "../live/book";
import { getTopOrders } from "../wfm/client";
import { WfmError } from "../wfm/errors";
import { PRIORITY } from "../wfm/limiter";
import type { TopOrders, WfmOrder } from "../wfm/types";
import type { ItemRow } from "./details";

/**
 * Refresh the items you are actively trading, every few minutes.
 *
 * This used to be implemented as a sweep — a real sweep row covering just the
 * watched items. That was the bug behind two separate failures:
 *
 *   - it became "the latest sweep", so the ranking, the sniper and stats all
 *     saw only the watched items and the rest of the market vanished;
 *   - it advanced the ghost counter every five minutes, so watched orders read
 *     as long-unsold ghosts within the hour.
 *
 * A watchlist read is not a sweep, so it no longer pretends to be one. It
 * feeds the same live overlay the order feed uses — which the ranking, the
 * sniper and sell advice all already read — and records orders without
 * counting as a sweep.
 */

export interface WatchlistResult {
  ok: number;
  failed: number;
  /** Prices the refresh improved on the live book. */
  liveUpdates: number;
}

export async function refreshWatched(
  db: Db,
  items: ItemRow[],
  opts: {
    signal?: AbortSignal;
    /** Injectable for tests; defaults to /v2/orders/item/{slug}/top. */
    fetchTop?: (slug: string, signal?: AbortSignal) => Promise<TopOrders>;
  } = {},
): Promise<WatchlistResult> {
  const fetchTop =
    opts.fetchTop ?? ((slug: string, signal?: AbortSignal) => getTopOrders(slug, signal, PRIORITY.watchlist));
  let ok = 0;
  let failed = 0;
  let liveUpdates = 0;

  for (const item of items) {
    if (opts.signal?.aborted) break;
    try {
      const top = await fetchTop(item.slug, opts.signal);

      const ranked: Array<{ order: WfmOrder; rank: number }> = [
        ...top.sell.map((order, rank) => ({ order, rank })),
        ...top.buy.map((order, rank) => ({ order, rank })),
      ];

      // Real ranks — this IS a top-of-book read — but not a sweep, so it can
      // end a ghost streak on evidence of undercut and never extend one.
      recordOrders(db, ranked, { countsAsSweep: false });

      // Leaving the top five is genuine evidence, however often it is checked.
      markLeftTop(db, item.id, ranked.map((r) => r.order.id));

      liveUpdates += applyLiveOrders(db, [...top.sell, ...top.buy]);
      ok++;
    } catch (err) {
      failed++;
      if (!(err instanceof WfmError)) throw err;
    }
  }

  return { ok, failed, liveUpdates };
}
