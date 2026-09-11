/**
 * How long platinum stays tied up: the expected wait to sell, and how far the
 * history backs that estimate.
 *
 * The model is deliberately plain. Buyers work up from the cheapest listing —
 * the site sorts by price — so everyone listed below you sells first, and you
 * are the (queue + 1)th unit to move. At the rate the item trades that takes
 * (queue + 1) / units-per-day. It assumes everyone below you answers whispers
 * and nobody undercuts you meanwhile, which is why it ships with a confidence
 * rather than alone.
 *
 * Every threshold here is a guess in the same sense as DEFAULT_POLICY: the
 * journal is what will say whether "high" deserves the name.
 */

export type Confidence = "high" | "medium" | "low";

export interface SellTimeInput {
  volume48h: number | null;
  volume7d: number | null;
  /** Distinct days in the last 30 with any trade — steady market or one spike. */
  daysTraded30d: number | null;
  /** Units listed below your price. Zero when you undercut the cheapest ask. */
  queue: number;
  sellAt: number;
  /** 7-day median of completed trades. */
  tradedMedian: number | null;
  /**
   * Waits between you and the platinum coming back. A spread has two — your
   * bid has to be filled before your ask can sell — and counting only the
   * second made every spread look twice as quick as a set.
   */
  legs?: number;
}

export interface SellTime {
  /** Expected days to sell; null when nothing has traded to estimate from. */
  days: number | null;
  confidence: Confidence;
  /** The numbers behind it, for a tooltip. */
  basis: string;
}

/** Above this multiple of the traded median, fewer buyers exist at your price. */
const ABOVE_TRADED = 1.1;

export function sellTime(i: SellTimeInput): SellTime {
  // The week is the steadier rate; 48h stands in when the week is missing.
  const perDay =
    i.volume7d !== null && i.volume7d > 0 ? i.volume7d / 7 : Math.max(0, i.volume48h ?? 0) / 2;
  if (perDay <= 0) {
    return { days: null, confidence: "low", basis: "nothing has traded to estimate from" };
  }

  const tradedDays = i.daysTraded30d ?? 0;
  const week = i.volume7d ?? 0;
  // Steady (traded most days) and enough trades that a day's noise washes out.
  let level = tradedDays >= 20 && week >= 14 ? 2 : tradedDays >= 10 && week >= 5 ? 1 : 0;

  // The rate is measured at the median. Asking above it, fewer of those buyers
  // are yours — the estimate is optimistic, so trust it one step less.
  const above =
    i.tradedMedian !== null && i.tradedMedian > 0 && i.sellAt > i.tradedMedian * ABOVE_TRADED;
  if (above && level > 0) level--;

  const legs = Math.max(1, i.legs ?? 1);
  const days = (legs * (i.queue + 1)) / perDay;
  const basis =
    `${perDay < 10 ? perDay.toFixed(1) : Math.round(perDay)} sold a day this week, ` +
    `traded on ${tradedDays} of the last 30 days` +
    (i.queue > 0 ? `, ${i.queue} listed below you` : "") +
    (above ? `; asking above the ${Math.round(i.tradedMedian!)}p it trades at` : "") +
    (legs > 1 ? "; counts your bid filling as well as your ask selling" : "");

  return {
    days: Number(days.toFixed(3)),
    confidence: (["low", "medium", "high"] as const)[level]!,
    basis,
  };
}

/**
 * The fastest a trade can realistically turn over. Whispering, meeting in game
 * and trading take hours whatever the market does, and without a floor a
 * hundred-a-day item sells "in fifteen minutes" and every per-day figure built
 * on it becomes enormous.
 */
export const MIN_CYCLE_DAYS = 0.25;

/**
 * Return per day tied up: the plan's default ranking. A 15p edge on 60p that
 * sells in a day beats 400p on 900p that sits for a week — and this is the
 * number that says so.
 */
export function returnPerDay(margin: number, outlay: number, days: number | null): number {
  if (days === null || outlay <= 0) return 0;
  return margin / outlay / Math.max(days, MIN_CYCLE_DAYS);
}
