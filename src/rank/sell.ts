import type { Db } from "../db/index";
import { latestSweepId } from "./query";
import { LIVE_OVERLAY, liveCutoff } from "../live/book";

/**
 * What to list something at, once you already hold it.
 *
 * The whole tool points at the buy side, but the buy leg is the easy one — you
 * whisper someone and it either happens or it doesn't. The sell leg is where
 * platinum actually sits waiting, and nothing here helped with it.
 *
 * Two independent sources are needed, because each is misleading alone:
 *
 *   The BOOK says what you must undercut to be seen. It says nothing about
 *   whether anyone buys at that level — an item can have asks at 74p and trade
 *   at 47p all week.
 *
 *   The HISTORY says where trades actually clear. It says nothing about who is
 *   currently in front of you in the queue.
 *
 * A price that beats the book but sits above the traded range will not sell; a
 * price inside the traded range that is above the cheapest ask will not be seen.
 */

/** Days of history to characterise the clearing range. */
const WINDOW_DAYS = 14;

export interface SellAdvice {
  itemId: string;
  variant: string;
  /** Cheapest live ask, which you must beat to be top of book. */
  lowestAsk: number | null;
  /** Live asks strictly cheaper than `fair` — these clear before you do. */
  queueAtFair: number;
  /** Median of daily medians: where this normally changes hands. */
  tradedMedian: number | null;
  /** Typical daily low and high, so the spread of outcomes is visible. */
  tradedLow: number | null;
  tradedHigh: number | null;
  /** Mean units traded per day over the window. */
  dailyVolume: number;
  daysOfHistory: number;

  /** Undercut the book to move it today. */
  quickPrice: number | null;
  /** Where it normally clears. */
  fairPrice: number | null;
  /** Top of the recent range — only if you are willing to wait. */
  patientPrice: number | null;
  /** Rough wait at `fairPrice`, from queue depth and daily volume. */
  estimatedDaysAtFair: number | null;
  /**
   * Set when even the cheapest ask sits above the traded range, so undercutting
   * the book still leaves you above where anyone buys.
   */
  bookAboveMarket: boolean;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const round = (n: number | null): number | null => (n === null ? null : Math.round(n));

export function sellAdvice(db: Db, itemId: string, variant = ""): SellAdvice {
  const sweepId = latestSweepId(db);

  const days = db
    .prepare(
      `SELECT volume, median, min_price, max_price
         FROM stat_daily
        WHERE item_id = @itemId AND variant = @variant
          AND day >= date('now', @window)
        ORDER BY day`,
    )
    .all({ itemId, variant, window: `-${WINDOW_DAYS} days` }) as Array<{
    volume: number;
    median: number | null;
    min_price: number | null;
    max_price: number | null;
  }>;

  const tradedMedian = median(days.map((d) => d.median).filter((v): v is number => v !== null));
  const tradedLow = median(days.map((d) => d.min_price).filter((v): v is number => v !== null));
  const tradedHigh = median(days.map((d) => d.max_price).filter((v): v is number => v !== null));
  const dailyVolume = days.length
    ? Number((days.reduce((n, d) => n + d.volume, 0) / days.length).toFixed(1))
    : 0;

  // With the live overlay: a cheaper ask posted since the sweep — or seen by a
  // watchlist refresh — is competition you have to undercut, so it must count.
  // This read the sweep alone, so watching an item never improved its advice.
  const book = sweepId
    ? (db
        .prepare(
          `SELECT ${LIVE_OVERLAY.lowSell} AS low_sell
             FROM snapshot s
             LEFT JOIN live_book lb ON lb.item_id = s.item_id AND lb.variant = s.variant
            WHERE s.item_id = @itemId AND s.variant = @variant AND s.sweep_id = @sweep`,
        )
        .get({ itemId, variant, sweep: sweepId, liveCutoff: liveCutoff() }) as
        | { low_sell: number | null }
        | undefined)
    : undefined;
  const lowestAsk = book?.low_sell ?? null;

  // Where it normally clears, but never above what the book will let you be
  // seen at: being the 6th cheapest ask is the same as not being listed.
  const fairPrice =
    tradedMedian === null
      ? lowestAsk === null
        ? null
        : lowestAsk - 1
      : lowestAsk === null
        ? Math.round(tradedMedian)
        : Math.round(Math.min(tradedMedian, lowestAsk - 1));

  const queueAtFair =
    fairPrice === null
      ? 0
      : ((
          db
            .prepare(
              `SELECT COUNT(*) c FROM order_seen
                WHERE item_id = ? AND variant = ? AND type = 'sell'
                  AND left_top_at IS NULL AND platinum < ?`,
            )
            .get(itemId, variant, fairPrice) as { c: number }
        ).c);

  // Everyone cheaper than you sells first, so you are the (queue + 1)th unit to
  // move. Crude, and it assumes buyers work up from the bottom — which is what
  // they do, since the site sorts by price.
  const estimatedDaysAtFair =
    dailyVolume > 0 ? Number(((queueAtFair + 1) / dailyVolume).toFixed(1)) : null;

  return {
    itemId,
    variant,
    lowestAsk,
    queueAtFair,
    tradedMedian,
    tradedLow,
    tradedHigh,
    dailyVolume,
    daysOfHistory: days.length,
    quickPrice: lowestAsk !== null ? lowestAsk - 1 : round(tradedLow),
    fairPrice,
    patientPrice: round(tradedHigh),
    estimatedDaysAtFair,
    bookAboveMarket:
      lowestAsk !== null && tradedMedian !== null && lowestAsk > tradedMedian * 1.5,
  };
}
