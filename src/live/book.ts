import type { Db } from "../db/index";
import { variantKey, type WfmOrder } from "../wfm/types";

/**
 * The live order book, assembled from /v2/orders/recent between sweeps.
 *
 * The baseline sweep takes 22 minutes for the whole catalogue, so by the time
 * it finishes its first prices are already stale. The live feed touches ~313
 * items every ten minutes for a single request, which is far better coverage
 * for the items people are actually trading right now.
 *
 * The catch, and it governs the whole design: the feed reports orders being
 * POSTED. It never reports one being cancelled or filled. So an observation
 * here is evidence a price existed at a moment, not proof it still does — and
 * the cheapest asks are exactly the ones most likely to have been bought.
 * Hence the window: an observation stops counting once it is old enough that
 * the order behind it has probably gone.
 */

/** How long a live observation is trusted. Roughly the feed's own window. */
export const LIVE_WINDOW_MS = 15 * 60_000;

export function liveCutoff(now = Date.now()): string {
  return new Date(now - LIVE_WINDOW_MS).toISOString();
}

/**
 * Fold newly seen orders into the live book.
 *
 * A side is replaced when the new order is better than what we hold, or when
 * what we hold has expired — an expired record is worse than a fresh one at any
 * price, because at least the fresh one was real recently.
 */
export function applyLiveOrders(db: Db, orders: WfmOrder[], now = Date.now()): number {
  if (orders.length === 0) return 0;
  const seenAt = new Date(now).toISOString();
  const cutoff = liveCutoff(now);

  const sell = db.prepare(
    `INSERT INTO live_book (item_id, variant, low_sell, low_sell_at)
     VALUES (@itemId, @variant, @platinum, @seenAt)
     ON CONFLICT(item_id, variant) DO UPDATE SET
       low_sell    = excluded.low_sell,
       low_sell_at = excluded.low_sell_at
     WHERE live_book.low_sell IS NULL
        OR live_book.low_sell_at < @cutoff
        OR excluded.low_sell < live_book.low_sell`,
  );
  const buy = db.prepare(
    `INSERT INTO live_book (item_id, variant, high_buy, high_buy_at)
     VALUES (@itemId, @variant, @platinum, @seenAt)
     ON CONFLICT(item_id, variant) DO UPDATE SET
       high_buy    = excluded.high_buy,
       high_buy_at = excluded.high_buy_at
     WHERE live_book.high_buy IS NULL
        OR live_book.high_buy_at < @cutoff
        OR excluded.high_buy > live_book.high_buy`,
  );

  let applied = 0;
  db.transaction(() => {
    for (const order of orders) {
      if (!order.visible) continue;
      const params = {
        itemId: order.itemId,
        variant: variantKey(order),
        platinum: order.platinum,
        seenAt,
        cutoff,
      };
      const info = order.type === "sell" ? sell.run(params) : buy.run(params);
      applied += info.changes;
    }
  })();
  return applied;
}

/**
 * SQL fragments that overlay the live book onto a sweep snapshot.
 *
 * Written as explicit CASE rather than MIN()/COALESCE because either side may
 * be NULL, and SQLite's scalar MIN returns NULL if any argument is NULL — which
 * would erase a perfectly good snapshot price whenever the live side was empty.
 *
 * Callers must join `live_book lb` and bind `@liveCutoff`.
 */
export const LIVE_OVERLAY = {
  lowSell: `CASE
      WHEN lb.low_sell IS NOT NULL
       AND lb.low_sell_at > @liveCutoff
       AND (s.low_sell IS NULL OR lb.low_sell < s.low_sell)
      THEN lb.low_sell ELSE s.low_sell END`,
  highBuy: `CASE
      WHEN lb.high_buy IS NOT NULL
       AND lb.high_buy_at > @liveCutoff
       AND (s.high_buy IS NULL OR lb.high_buy > s.high_buy)
      THEN lb.high_buy ELSE s.high_buy END`,
  /** Non-null when either side of this row came from the live feed. */
  liveAt: `CASE
      WHEN lb.low_sell_at > @liveCutoff OR lb.high_buy_at > @liveCutoff
      THEN MAX(COALESCE(lb.low_sell_at,''), COALESCE(lb.high_buy_at,''))
      ELSE NULL END`,
} as const;
