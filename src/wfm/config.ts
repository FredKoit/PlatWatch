/**
 * Central configuration for every warframe.market call.
 *
 * PC-only by design: this project does not compare across platforms, so the
 * platform is fixed here rather than threaded through every call site.
 */

export const WFM_ORIGIN = "https://api.warframe.market";

/** Live API. Everything except price history lives here. */
export const V2 = `${WFM_ORIGIN}/v2`;

/**
 * Legacy API. Only `/v1/items/{slug}/statistics` still answers; its sibling
 * routes already return `403 Deprecated`. See statistics.ts.
 */
export const V1 = `${WFM_ORIGIN}/v1`;

export const PLATFORM = "pc" as const;
export const LANGUAGE = "en" as const;

/**
 * Identify the app. warframe.market is a small volunteer-run service; an
 * anonymous scraper is the first thing an operator blocks.
 */
export const USER_AGENT =
  "FrameTax/0.1 (personal trading scanner; +https://github.com/local/frametax)";

/**
 * Requests per second across the whole process. The documented ceiling is 3/s.
 * Staying at 3 with a burst of 3 gives a full catalogue sweep in ~21 minutes.
 */
export const RATE_PER_SECOND = 3;
export const RATE_BURST = 3;

/** Per-attempt network timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Retry policy for transient failures (429 and 5xx). */
export const RETRY = {
  maxAttempts: 4,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
} as const;

/** Where the item catalogue is cached between runs. */
export const CACHE_DIR = ".cache";
