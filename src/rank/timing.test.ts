import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_CYCLE_DAYS, returnPerDay, sellTime, type SellTimeInput } from "./timing";

const input = (over: Partial<SellTimeInput> = {}): SellTimeInput => ({
  volume48h: 20,
  volume7d: 70,
  daysTraded30d: 28,
  queue: 0,
  sellAt: 50,
  tradedMedian: 50,
  ...over,
});

test("top of the book sells at the next buyer: one over the daily rate", () => {
  const t = sellTime(input());
  assert.equal(t.days, 0.1, "70 a week is 10 a day, so the next buyer is a tenth of a day away");
  assert.equal(t.optimisticDays, 0.06);
  assert.equal(t.conservativeDays, 0.15);
  assert.equal(t.confidence, "high");
});

test("everyone listed below you sells first", () => {
  const t = sellTime(input({ queue: 9 }));
  assert.equal(t.days, 1, "ten units to move at ten a day");
});

test("a steady market earns high confidence; a spike does not", () => {
  // The same weekly volume, landing on 28 days of the month or on 4.
  assert.equal(sellTime(input({ daysTraded30d: 28 })).confidence, "high");
  assert.equal(sellTime(input({ daysTraded30d: 12, volume7d: 8 })).confidence, "medium");
  assert.equal(sellTime(input({ daysTraded30d: 4, volume7d: 70 })).confidence, "low");
});

test("asking above where it trades costs a step of confidence", () => {
  // The rate was measured at the median; above it, fewer of those buyers are yours.
  const t = sellTime(input({ sellAt: 60, tradedMedian: 50 }));
  assert.equal(t.confidence, "medium");
  assert.match(t.basis, /above the 50p it trades at/);
});

test("with nothing traded there is no estimate, only a warning", () => {
  const t = sellTime(input({ volume48h: 0, volume7d: 0 }));
  assert.equal(t.days, null);
  assert.equal(t.optimisticDays, null);
  assert.equal(t.conservativeDays, null);
  assert.equal(t.confidence, "low");
});

test("uncertain markets get a wider conservative scenario", () => {
  const high = sellTime(input({ daysTraded30d: 28 }));
  const low = sellTime(input({ daysTraded30d: 4 }));
  assert.ok(Math.abs(high.conservativeDays! - high.days! * 1.5) < 0.001);
  assert.ok(Math.abs(low.conservativeDays! - low.days! * 3) < 0.001);
});

test("a spread waits twice: for its bid to fill, then for its ask to sell", () => {
  const t = sellTime(input({ legs: 2 }));
  assert.equal(t.days, 0.2, "twice a single listing's wait");
  assert.match(t.basis, /bid filling as well as your ask selling/);
});

test("the 48h rate stands in when the week is missing", () => {
  assert.equal(sellTime(input({ volume7d: null, volume48h: 10 })).days, 0.2, "5 a day");
});

test("return per day favours the small quick trade over the big slow one", () => {
  // 15p on 60p selling in a day, against 400p on 900p sitting a week.
  const quick = returnPerDay(15, 60, 1);
  const slow = returnPerDay(400, 900, 7);
  assert.ok(quick > slow, `${quick.toFixed(3)} per day against ${slow.toFixed(3)}`);
});

test("return per day has a floor on how fast a trade can turn over", () => {
  // Without one, a hundred-a-day item "sells in fifteen minutes" and its
  // per-day return becomes absurd.
  assert.equal(returnPerDay(10, 100, 0.01), returnPerDay(10, 100, MIN_CYCLE_DAYS));
  assert.equal(returnPerDay(10, 100, null), 0, "no estimate earns no speed");
});
