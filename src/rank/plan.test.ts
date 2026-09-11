import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrades, type PlanCandidate, type PlanOptions } from "./plan";

const c = (itemId: string, buyAt: number, expectedMargin: number, over: Partial<PlanCandidate> = {}): PlanCandidate => ({
  itemId,
  variant: "",
  buyAt,
  expectedMargin,
  sellDays: 1,
  sellConfidence: "high",
  ...over,
});

const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  budget: 200,
  maxPerItem: null,
  minConfidence: "medium",
  sortBy: "profit",
  ...over,
});

test("the plan takes the best trades until the budget runs out", () => {
  const p = planTrades([c("a", 100, 30), c("b", 80, 20), c("c", 50, 10)], opts({ budget: 200 }));
  assert.deepEqual(p.picks.map((x) => x.itemId), ["a", "b"]);
  assert.equal(p.spent, 180);
  assert.equal(p.expectedProfit, 50);
  assert.deepEqual(p.picks.map((x) => x.runningTotal), [100, 180]);
});

test("a trade that does not fit is skipped, not a stopping point", () => {
  // 150 cannot follow 100 in a 200p budget, but the 60p one further down can.
  const p = planTrades([c("a", 100, 40), c("big", 150, 35), c("small", 60, 10)], opts({ budget: 200 }));
  assert.deepEqual(p.picks.map((x) => x.itemId), ["a", "small"]);
  assert.equal(p.skipped.overBudget, 1);
});

test("no item takes more than the per-item limit", () => {
  const p = planTrades([c("dear", 400, 120), c("cheap", 60, 15)], opts({ budget: 1000, maxPerItem: 150 }));
  assert.deepEqual(p.picks.map((x) => x.itemId), ["cheap"]);
  assert.equal(p.skipped.overCap, 1);
});

test("what you already hold counts against the limit", () => {
  // 100p already tied up in "a": another 80p would put 180p in one item.
  const p = planTrades([c("a", 80, 30), c("b", 80, 10)], opts({
    budget: 500,
    maxPerItem: 150,
    held: new Map([["a|", 100]]),
  }));
  assert.deepEqual(p.picks.map((x) => x.itemId), ["b"]);
  assert.equal(p.skipped.held, 1, "reported as a position you hold, not as too expensive");
});

test("one trade per item — a spread and set arbitrage on the same set compete for its buyers", () => {
  const p = planTrades([c("set", 60, 20), c("set", 50, 15)], opts({ budget: 500 }));
  assert.equal(p.picks.length, 1);
});

test("low-confidence selling times are left out unless asked for", () => {
  const shaky = c("shaky", 50, 40, { sellConfidence: "low" });
  assert.equal(planTrades([shaky], opts()).picks.length, 0);
  assert.equal(planTrades([shaky], opts()).skipped.lowConfidence, 1);
  assert.equal(planTrades([shaky], opts({ minConfidence: "low" })).picks.length, 1);
});

test("return per day puts the quick small trade ahead of the slow big one", () => {
  const quick = c("quick", 60, 15, { sellDays: 1 });
  const slow = c("slow", 900, 400, { sellDays: 7 });
  const byProfit = planTrades([quick, slow], opts({ budget: 2000, sortBy: "profit" }));
  const bySpeed = planTrades([quick, slow], opts({ budget: 2000, sortBy: "speed" }));
  assert.equal(byProfit.picks[0]!.itemId, "slow");
  assert.equal(bySpeed.picks[0]!.itemId, "quick");
});

test("a trade your record says loses money is never planned", () => {
  const p = planTrades([c("loser", 50, -5)], opts());
  assert.equal(p.picks.length, 0);
});
