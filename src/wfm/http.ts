import {
  LANGUAGE,
  PLATFORM,
  RATE_BURST,
  RATE_PER_SECOND,
  REQUEST_TIMEOUT_MS,
  RETRY,
  USER_AGENT,
} from "./config";
import {
  WfmEndpointRetiredError,
  WfmHttpError,
  WfmNotFoundError,
  WfmShapeError,
  WfmUnavailableError,
} from "./errors";
import { RateLimiter } from "./limiter";

/** The one budget for this process. Every request in the app goes through it. */
export const limiter = new RateLimiter({
  ratePerSecond: RATE_PER_SECOND,
  burst: RATE_BURST,
});

export interface Logger {
  warn(message: string): void;
}
/** Swap this out for a real logger; retries should never be silent. */
export let logger: Logger = { warn: (m) => console.warn(`[wfm] ${m}`) };
export function setLogger(next: Logger): void {
  logger = next;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** See PRIORITY in limiter.ts. Live polls must not queue behind a sweep. */
  priority?: number;
}

function defaultHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "User-Agent": USER_AGENT,
    Platform: PLATFORM,
    Language: LANGUAGE,
  };
}

function backoffDelay(attempt: number): number {
  const ceiling = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * RETRY.factor ** attempt);
  // Equal jitter: half the wait is fixed, half is random, so a batch of
  // simultaneous failures doesn't retry in lockstep.
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * One rate-limited GET with retries. Returns the parsed JSON body.
 *
 * Retries 429 and 5xx; a 429 pauses the shared limiter so the backoff applies
 * to every in-flight caller, not just this one.
 */
export async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  let lastCause: unknown;

  for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
    await limiter.acquire(opts.signal, opts.priority);

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { ...defaultHeaders(), ...opts.headers },
        signal,
        redirect: "follow",
      });
    } catch (cause) {
      // A caller-driven abort is intentional; never retry it.
      if (opts.signal?.aborted) throw opts.signal.reason;
      lastCause = cause;
      const wait = backoffDelay(attempt);
      logger.warn(`network error on ${url} (attempt ${attempt + 1}), retrying in ${Math.round(wait)}ms`);
      await sleep(wait, opts.signal);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WfmShapeError(url, `body was not JSON (${text.slice(0, 120)})`);
      }
    }

    const body = await res.text().catch(() => "");

    // Permanent failures — fail immediately and loudly.
    if (res.status === 403) throw new WfmEndpointRetiredError(url, body);
    if (res.status === 404) throw new WfmNotFoundError(url);

    const transient = res.status === 429 || res.status >= 500;
    if (!transient) throw new WfmHttpError(res.status, url, body);

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const wait = retryAfter ?? backoffDelay(attempt);
      limiter.pauseFor(wait);
      logger.warn(`429 from ${url}; pausing all requests for ${Math.round(wait)}ms`);
      lastCause = new WfmHttpError(res.status, url, body);
      await sleep(wait, opts.signal);
      continue;
    }

    lastCause = new WfmHttpError(res.status, url, body);
    const wait = backoffDelay(attempt);
    logger.warn(`HTTP ${res.status} on ${url} (attempt ${attempt + 1}), retrying in ${Math.round(wait)}ms`);
    await sleep(wait, opts.signal);
  }

  throw new WfmUnavailableError(url, RETRY.maxAttempts, lastCause);
}

/** Envelope used by every v2 route: `{ apiVersion, data, error }`. */
interface V2Envelope<T> {
  apiVersion?: string;
  data?: T;
  error?: unknown;
}

/** GET a v2 route and unwrap its `data` envelope. */
export async function getV2<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const body = await getJson<V2Envelope<T>>(url, opts);
  if (body.error) {
    throw new WfmShapeError(url, `API returned error: ${JSON.stringify(body.error).slice(0, 160)}`);
  }
  if (body.data === undefined) throw new WfmShapeError(url, "envelope had no `data`");
  return body.data;
}
