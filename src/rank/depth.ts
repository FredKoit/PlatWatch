import type { Db } from "../db/index";
import { liveCutoff } from "../live/book";

export const ACTIONABLE_SWEEP_WINDOW_MS = 6 * 60 * 60 * 1000;
export const actionableSweepCutoff = (now = Date.now()) => new Date(now - ACTIONABLE_SWEEP_WINDOW_MS).toISOString();

/**
 * What you can actually buy — not what the cheapest price says.
 *
 * Two facts the set costing used to ignore:
 *
 *   An order has a QUANTITY. A set needing two blades, priced off a seller
 *   holding one, costs the cheapest blade plus the next one up — not twice the
 *   cheapest. Walking the book is the only honest way to cost it.
 *
 *   A seller has to be REACHABLE. The live feed records every order posted,
 *   including offline sellers' and orders filled minutes later, and those rows
 *   stayed "on the book" until the next sweep. So the cheapest seller offered
 *   for a part was often someone you could not trade with: 172 of 766 set
 *   parts showed a seller below the price the set had been costed at.
 */

export interface BookOrder {
  orderId: string;
  userId: string;
  ingameName: string;
  platinum: number;
  /** Units on the order; null when it was recorded before quantities were kept. */
  quantity: number | null;
  /** The owner's status when last seen; null when not recorded. */
  status: string | null;
  lastSeen: string;
}

/**
 * The rule for an order you could whisper right now.
 *
 * On the book, not owned by someone last seen offline, and observed inside
 * the trust window, whether by a top-of-book read or the live feed.
 * A top rank describes a past observation, not permanent availability.
 * An older sighting is evidence an order existed, not that it still does —
 * Full top-of-book observations remain usable for six hours. Feed-only orders
 * keep the tighter 15-minute window because the recent feed reports creation,
 * not continued availability. Every proposed purchase is refreshed again by
 * Verify before buying.
 *
 * Callers bind `@liveCutoff`.
 */
export const REACHABLE_ORDER = `
  left_top_at IS NULL
  AND COALESCE(user_status, '') != 'offline'
  AND ((top_rank IS NOT NULL AND last_seen > @actionableCutoff)
    OR (top_rank IS NULL AND last_seen > @liveCutoff))`;

/**
 * A reader for reachable orders, best price first: cheapest ask, highest bid.
 * One prepared statement, because costing every set reads a thousand books.
 */
export function bookReader(db: Db, now = Date.now()) {
  const stmt = db.prepare(
    `SELECT order_id AS orderId, user_id AS userId, ingame_name AS ingameName,
            platinum, quantity, user_status AS status, last_seen AS lastSeen
       FROM order_seen
      WHERE item_id = @itemId AND variant = @variant AND type = @type
        AND ${REACHABLE_ORDER}
      ORDER BY CASE WHEN @type = 'sell' THEN platinum END ASC,
               CASE WHEN @type = 'buy'  THEN platinum END DESC,
               last_seen DESC`,
  );
  const cutoff = liveCutoff(now);
  const sweepCutoff = actionableSweepCutoff(now);
  return (itemId: string, variant: string, type: "sell" | "buy"): BookOrder[] =>
    stmt.all({ itemId, variant, type, liveCutoff: cutoff, actionableCutoff: sweepCutoff }) as BookOrder[];
}

export interface Fill {
  order: BookOrder;
  units: number;
}

export interface FillResult {
  /** Cost of the whole quantity, walking up the book; null when the book is too thin. */
  cost: number | null;
  /** Units the book can supply, up to the quantity asked for. */
  available: number;
  /** Which orders supply them, cheapest first. */
  fills: Fill[];
}

/**
 * Take `qty` units from the cheapest order up.
 *
 * An order of unknown quantity counts as ONE unit. Assuming more would price a
 * two-part need off a single seller who may hold one; assuming one can only
 * ever overstate the cost, and the next sweep records the real quantity.
 */
export function fillFromBook(asks: BookOrder[], qty: number): FillResult {
  const sorted = [...asks].sort((a, b) => a.platinum - b.platinum);
  const fills: Fill[] = [];
  let need = qty;
  let cost = 0;
  for (const order of sorted) {
    if (need <= 0) break;
    const units = Math.min(need, Math.max(1, order.quantity ?? 1));
    fills.push({ order, units });
    cost += units * order.platinum;
    need -= units;
  }
  return { cost: need > 0 ? null : cost, available: qty - Math.max(0, need), fills };
}

/** Units listed strictly below a price — the queue that sells before you do. */
export function unitsBelow(asks: BookOrder[], price: number): number {
  return asks
    .filter((a) => a.platinum < price)
    .reduce((n, a) => n + Math.max(1, a.quantity ?? 1), 0);
}
