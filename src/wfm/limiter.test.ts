import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIORITY, RateLimiter } from "./limiter";

/** Virtual clock so rate-limit behaviour is tested without real waiting. */
class FakeClock {
  t = 0;
  #id = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.#id;
    this.#timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.#timers.delete(h as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId)!;
      this.#timers.delete(nextId);
      this.t = timer.at;
      timer.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function build(clock: FakeClock, ratePerSecond = 3, burst = 3) {
  return new RateLimiter({
    ratePerSecond,
    burst,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

/** Marks each acquire as it resolves so ordering and timing are observable. */
function track(limiter: RateLimiter, n: number) {
  const done: number[] = [];
  const promises = Array.from({ length: n }, (_, i) =>
    limiter.acquire().then(() => {
      done.push(i);
    }),
  );
  return { done, promises };
}

test("spends the burst immediately, then throttles to the sustained rate", async () => {
  const clock = new FakeClock();
  const limiter = build(clock);
  const { done } = track(limiter, 5);
  await flush();

  assert.deepEqual(done, [0, 1, 2], "burst of 3 should go out at once");

  // At 3/s a token accrues every ~333ms.
  await clock.advance(200);
  assert.deepEqual(done, [0, 1, 2], "no token yet at 200ms");

  await clock.advance(140);
  assert.deepEqual(done, [0, 1, 2, 3], "4th released once a token accrued");

  await clock.advance(334);
  assert.deepEqual(done, [0, 1, 2, 3, 4], "5th follows one interval later");
});

test("releases in FIFO order", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  const { done } = track(limiter, 4);
  await flush();
  await clock.advance(2000);
  assert.deepEqual(done, [0, 1, 2, 3]);
});

test("pauseFor holds every caller back, even with tokens in hand", async () => {
  const clock = new FakeClock();
  const limiter = build(clock);

  limiter.pauseFor(1000);
  const { done } = track(limiter, 2);
  await flush();
  assert.deepEqual(done, [], "a 429 pause must stop even burst-eligible callers");

  await clock.advance(999);
  assert.deepEqual(done, [], "still paused");

  await clock.advance(2);
  assert.deepEqual(done, [0, 1], "resumes when the pause expires");
});

test("pauseFor never shortens an existing pause", async () => {
  const clock = new FakeClock();
  const limiter = build(clock);
  limiter.pauseFor(1000);
  limiter.pauseFor(100);
  assert.equal(limiter.pausedForMs, 1000);
});

test("an aborted waiter rejects and leaves the queue", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  await limiter.acquire(); // drain the single burst token

  const controller = new AbortController();
  const pending = limiter.acquire(controller.signal);
  await flush();
  assert.equal(limiter.pending, 1);

  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(limiter.pending, 0, "aborted waiter must not hold a slot");
});

test("an already-aborted signal rejects without queueing", async () => {
  const clock = new FakeClock();
  const limiter = build(clock);
  const controller = new AbortController();
  controller.abort(new Error("gone"));
  await assert.rejects(limiter.acquire(controller.signal), /gone/);
  assert.equal(limiter.pending, 0);
});

test("a live poll jumps ahead of a queued bulk crawl", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  await limiter.acquire(); // spend the only burst token

  const order: string[] = [];
  // A sweep queues a long run of bulk requests first.
  for (let i = 0; i < 5; i++) {
    void limiter.acquire(undefined, PRIORITY.bulk).then(() => order.push(`bulk${i}`));
  }
  // Then the watcher polls. It must not wait for all five.
  void limiter.acquire(undefined, PRIORITY.live).then(() => order.push("live"));
  await flush();

  await clock.advance(340);
  assert.deepEqual(order, ["live"], "the live poll is served first");

  await clock.advance(340);
  assert.deepEqual(order, ["live", "bulk0"], "then the bulk queue resumes in order");
});

test("equal priorities stay FIFO", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  await limiter.acquire();

  const order: number[] = [];
  for (let i = 0; i < 4; i++) {
    void limiter.acquire(undefined, PRIORITY.watchlist).then(() => order.push(i));
  }
  await flush();
  await clock.advance(2000);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("priority bands are ordered, not just live-vs-rest", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  await limiter.acquire();

  const order: string[] = [];
  void limiter.acquire(undefined, PRIORITY.bulk).then(() => order.push("bulk"));
  void limiter.acquire(undefined, PRIORITY.live).then(() => order.push("live"));
  void limiter.acquire(undefined, PRIORITY.watchlist).then(() => order.push("watchlist"));
  await flush();
  await clock.advance(2000);
  assert.deepEqual(order, ["live", "watchlist", "bulk"]);
});

test("a high-priority waiter that aborts leaves the queue intact", async () => {
  const clock = new FakeClock();
  const limiter = build(clock, 3, 1);
  await limiter.acquire();

  const order: string[] = [];
  void limiter.acquire(undefined, PRIORITY.bulk).then(() => order.push("bulk"));
  const controller = new AbortController();
  const cancelled = limiter.acquire(controller.signal, PRIORITY.live).then(() => order.push("live"));
  await flush();

  controller.abort(new Error("poll cancelled"));
  await assert.rejects(cancelled, /poll cancelled/);
  await clock.advance(400);
  assert.deepEqual(order, ["bulk"], "the bulk request still runs");
  assert.equal(limiter.pending, 0);
});
