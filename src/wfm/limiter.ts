/**
 * A token bucket shared by every caller in the process.
 *
 * The crawler and the live poller both hit the same upstream budget, so the
 * limiter must be a single instance rather than one per module — two modules
 * each politely doing 3/s is 6/s at the server.
 */

export interface RateLimiterOptions {
  /** Sustained rate. */
  ratePerSecond: number;
  /** How many requests may go out back-to-back after an idle period. */
  burst?: number;
  /** Injectable clock + timer, for deterministic tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  detach?: () => void;
  priority: number;
  /** Insertion order, so equal priorities stay FIFO. */
  seq: number;
}

/**
 * Higher goes first. A full catalogue sweep saturates the budget for twenty
 * minutes; without priority the live poll queues behind it and the freshest
 * data in the system arrives last.
 */
export const PRIORITY = {
  live: 20,
  watchlist: 10,
  bulk: 0,
} as const;

export class RateLimiter {
  readonly #capacity: number;
  readonly #tokensPerMs: number;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #tokens: number;
  #lastRefill: number;
  #seq = 0;
  #queue: Waiter[] = [];
  #timer: unknown = null;
  #pausedUntil = 0;

  constructor(opts: RateLimiterOptions) {
    if (opts.ratePerSecond <= 0) throw new RangeError("ratePerSecond must be > 0");
    this.#tokensPerMs = opts.ratePerSecond / 1000;
    this.#capacity = Math.max(1, opts.burst ?? Math.ceil(opts.ratePerSecond));
    this.#now = opts.now ?? Date.now;
    // A refill timer is armed ONLY while callers are queued, so it must keep
    // the event loop alive. Unref-ing it here made short-lived scripts exit 0
    // in the middle of a crawl: burst spent, no fetch in flight, nothing
    // referenced, process gone.
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.#tokens = this.#capacity;
    this.#lastRefill = this.#now();
  }

  /** Queue depth, for logging a long crawl. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Milliseconds remaining on a global pause, or 0. */
  get pausedForMs(): number {
    return Math.max(0, this.#pausedUntil - this.#now());
  }

  /**
   * Hold *every* caller back — used when the server says 429. A single
   * overloaded response should slow the whole process, not just the one
   * request that happened to receive it.
   */
  pauseFor(ms: number): void {
    if (ms <= 0) return;
    const until = this.#now() + ms;
    if (until > this.#pausedUntil) this.#pausedUntil = until;
    this.#pump();
  }

  /**
   * Resolves when the caller may send its request.
   *
   * Higher `priority` is served first; equal priorities are FIFO. Note this is
   * not preemption — a request already in flight is never interrupted, so a
   * high-priority caller waits at most one slot.
   */
  acquire(signal?: AbortSignal, priority: number = PRIORITY.bulk): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, priority, seq: this.#seq++ };

      if (signal) {
        const onAbort = () => {
          const i = this.#queue.indexOf(waiter);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
      }

      this.#enqueue(waiter);
      this.#pump();
    });
  }

  /** Insert by priority, keeping FIFO within a priority band. */
  #enqueue(waiter: Waiter): void {
    let i = this.#queue.length;
    while (i > 0 && this.#queue[i - 1]!.priority < waiter.priority) i--;
    this.#queue.splice(i, 0, waiter);
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#tokensPerMs);
    this.#lastRefill = now;
  }

  #pump(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#refill();

    const now = this.#now();
    if (now < this.#pausedUntil) {
      this.#armAt(this.#pausedUntil - now);
      return;
    }

    while (this.#queue.length > 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      const waiter = this.#queue.shift()!;
      waiter.detach?.();
      waiter.resolve();
    }

    if (this.#queue.length > 0) {
      const deficit = 1 - this.#tokens;
      this.#armAt(Math.max(1, Math.ceil(deficit / this.#tokensPerMs)));
    }
  }

  #armAt(ms: number): void {
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#pump();
    }, ms);
  }
}
