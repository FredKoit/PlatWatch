/**
 * When a market last traded — as precisely as the data allows.
 *
 * Shared by the ranking and the live sniper so the two cannot drift apart.
 * They used to each carry their own copy of this check, and both were wrong in
 * the same way:
 *
 *   The v1 statistics endpoint returns CLOSED periods only. The daily series
 *   never includes today, so its newest bucket is always at least a day old at
 *   the moment you fetch it. Freshness was measured from the START of that day
 *   against a two-day limit, so every item in the catalogue failed at midnight
 *   UTC and stayed failed until the next stats fetch — the ranking was empty for
 *   about 19 hours of every 24.
 *
 * Two corrections, both needed:
 *
 *   1. Prefer the HOURLY series, which is current to within the hour.
 *   2. A bucket says a trade happened somewhere inside its period, so the
 *      honest "last traded by" is the END of the period, not the start.
 */

export const MAX_HISTORY_STALE_HOURS = 48;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface TradeRecency {
  /** ISO timestamp from the hourly series, end of the newest bucket. */
  lastTradedAt?: string | null;
  /** Legacy: YYYY-MM-DD of the newest closed daily bucket. */
  lastTradedDay?: string | null;
}

/**
 * Milliseconds-since-epoch of the most recent trade we can vouch for, or null
 * when there is no history at all.
 *
 * Falls back to the end of the daily bucket for rows written before the hourly
 * timestamp existed, which is still a day behind but no longer a day and a
 * half behind.
 */
export function lastTradedMs(r: TradeRecency): number | null {
  if (r.lastTradedAt) {
    const t = Date.parse(r.lastTradedAt);
    if (!Number.isNaN(t)) return t;
  }
  if (r.lastTradedDay) {
    const start = Date.parse(`${r.lastTradedDay}T00:00:00Z`);
    if (!Number.isNaN(start)) return start + DAY;
  }
  return null;
}

export function hoursSinceTrade(r: TradeRecency, now = Date.now()): number | null {
  const t = lastTradedMs(r);
  return t === null ? null : (now - t) / HOUR;
}

/** End of the newest bucket in a series: when its last trade had happened by. */
export function periodEnd(datetime: string, periodMs: number): string {
  return new Date(Date.parse(datetime) + periodMs).toISOString();
}

export const HOURLY_PERIOD_MS = HOUR;
export const DAILY_PERIOD_MS = DAY;
