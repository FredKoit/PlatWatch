import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DUCAT_POLICY,
  planSpend,
  rankDucats,
  scoreDucat,
  type DucatRow,
} from "./ducats";

const raw = (over: Partial<DucatRow> = {}) => ({
  itemId: "i",
  slug: "bronco_prime_barrel",
  name: "Bronco Prime Barrel",
  ducats: 45,
  buyAt: 2,
  volume48h: 58,
  tradedMedian: 2,
  bookAgeH: 3,
  sellCount: 5,
  liveAt: null,
  ...over,
});

test("the rate is ducats divided by what you actually pay", () => {
  const r = scoreDucat(raw())!;
  assert.equal(r.ducatsPerPlat, 22.5, "45 ducats for 2p");
  assert.deepEqual(r.rejects, []);
});

test("the same part at a worse price is the same ducats for more platinum", () => {
  // The conversion is fixed, so only the purchase price moves the rate.
  const cheap = scoreDucat(raw({ buyAt: 2 }))!;
  const dear = scoreDucat(raw({ buyAt: 20, tradedMedian: 20 }))!;
  assert.equal(cheap.ducats, dear.ducats);
  assert.equal(dear.ducatsPerPlat, 2.25);
  assert.ok(dear.rejects.some((x) => x.includes("ducats per platinum")));
  assert.deepEqual(rankDucats([dear]), []);
});

test("a big ducat value at a bad price loses to a small one at a good price", () => {
  const bigExpensive = scoreDucat(
    raw({ itemId: "big", ducats: 350, buyAt: 100, tradedMedian: 100 }),
  )!;
  const smallCheap = scoreDucat(raw({ itemId: "small", ducats: 45, buyAt: 2 }))!;
  const ranked = rankDucats([bigExpensive, smallCheap]);
  assert.equal(ranked[0]!.itemId, "small", "3.5 per platinum against 22.5");
});

test("an ask far above the traded price is not a price you would pay", () => {
  const r = scoreDucat(raw({ buyAt: 4, tradedMedian: 2 }))!;
  assert.ok(
    r.rejects.some((x) => x.includes("above the")),
    `got ${JSON.stringify(r.rejects)}`,
  );
});

test("an ask at the traded price passes", () => {
  const r = scoreDucat(raw({ buyAt: 3, tradedMedian: 2.5 }))!;
  assert.deepEqual(r.rejects, []);
});

test("nobody selling means nothing to buy", () => {
  const r = scoreDucat(raw({ volume48h: 1 }))!;
  assert.ok(r.rejects.some((x) => x.includes("volume")));
});

test("a free item is not an infinite rate", () => {
  assert.equal(scoreDucat(raw({ buyAt: 0 })), null);
});

test("the capital cap applies per item", () => {
  const r = scoreDucat(raw({ ducats: 350, buyAt: 30, tradedMedian: 30 }), {
    ...DEFAULT_DUCAT_POLICY,
    maxBuyAt: 10,
  })!;
  assert.ok(r.rejects.some((x) => x.includes("up front")));
});

test("a budget plan reports the blended rate, not the best one", () => {
  const rows = rankDucats([
    scoreDucat(raw({ itemId: "a", ducats: 45, buyAt: 2 })),
    scoreDucat(raw({ itemId: "b", ducats: 45, buyAt: 3, tradedMedian: 3 })),
    scoreDucat(raw({ itemId: "c", ducats: 100, buyAt: 8, tradedMedian: 8 })),
  ]);

  const plan = planSpend(rows, 13);
  assert.equal(plan.items, 3);
  assert.equal(plan.spent, 13);
  assert.equal(plan.ducats, 190);
  assert.equal(plan.ducatsPerPlat, 14.62, "below the 22.5 the top row alone suggests");
});

test("a budget too small for anything buys nothing", () => {
  const rows = rankDucats([scoreDucat(raw({ buyAt: 50, tradedMedian: 50, ducats: 500 }))]);
  const plan = planSpend(rows, 10);
  assert.equal(plan.items, 0);
  assert.equal(plan.ducatsPerPlat, 0, "and does not divide by zero");
});
