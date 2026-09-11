import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  gate,
  rank,
  scoreSet,
  scoreSpread,
  setSellPrice,
  type MarketRow,
} from "./score";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const today = "2026-09-10";

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  itemId: "i",
  slug: "thing",
  name: "Thing",
  variant: "",
  lowSell: 60,
  highBuy: 45,
  sellP50: 66,
  sellCount: 5,
  buyCount: 5,
  bookAgeH: 2,
  volume48h: 100,
  volume7d: 400,
  median7d: 62,
  daysTraded30d: 30,
  lastTradedDay: today,
  ...over,
});

test("spread margin accounts for having to undercut both sides", () => {
  const o = scoreSpread(row(), DEFAULT_POLICY, NOW)!;
  // Best bid 45, best ask 60. You bid 46 and ask 59, so you keep 13, not 15.
  assert.equal(o.buyAt, 46);
  assert.equal(o.sellAt, 59);
  assert.equal(o.margin, 13);
  assert.deepEqual(o.rejects, []);
});

test("a huge spread on a dead item is rejected on volume", () => {
  // Modelled on Arcane Squall Helmet: 480p spread, almost nothing trades.
  const o = scoreSpread(
    row({ name: "Arcane Squall Helmet", lowSell: 600, highBuy: 120, volume48h: 0 }),
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.ok(o.margin > 400, "the spread really is enormous");
  assert.ok(
    o.rejects.some((r) => r.includes("volume")),
    `expected a volume rejection, got ${JSON.stringify(o.rejects)}`,
  );
  assert.deepEqual(rank([o]), [], "and it must not appear in the ranking");
});

test("a stale book is rejected however wide the spread", () => {
  const o = scoreSpread(row({ lowSell: 600, highBuy: 120, bookAgeH: 842 }), DEFAULT_POLICY, NOW)!;
  assert.ok(o.rejects.some((r) => r.includes("842h old")));
});

test("history that stopped days ago is rejected", () => {
  const o = scoreSpread(row({ lastTradedDay: "2026-09-05" }), DEFAULT_POLICY, NOW)!;
  assert.ok(
    o.rejects.some((r) => r.includes("last traded")),
    `got ${JSON.stringify(o.rejects)}`,
  );
});

test("a single cheap order is not enough to price on", () => {
  const o = scoreSpread(row({ sellCount: 1 }), DEFAULT_POLICY, NOW)!;
  assert.ok(o.rejects.some((r) => r.includes("only 1 sell orders")));
});

test("a few platinum on an expensive item is noise, not edge", () => {
  const o = scoreSpread(row({ lowSell: 205, highBuy: 200 }), DEFAULT_POLICY, NOW)!;
  assert.ok(o.rejects.some((r) => r.includes("too thin") || r.includes("margin")));
});

test("missing history counts as no liquidity", () => {
  const rejects = gate(
    { volume48h: null, sellCount: 5, bookAgeH: 1, lastTradedDay: null },
    DEFAULT_POLICY,
    NOW,
  );
  assert.ok(rejects.some((r) => r.includes("volume 0")));
  assert.ok(rejects.some((r) => r.includes("no trade history")));
});

test("set cost multiplies each component by the quantity needed", () => {
  // Dual Kamas: blade x2, handle x2, blueprint x1 against an 88p set.
  const o = scoreSet(
    {
      set: row({ name: "Dual Kamas Prime Set", lowSell: 88, median7d: 88, volume48h: 21 }),
      parts: [
        { itemId: "blade", name: "Dual Kamas Prime Blade", qty: 2, lowSell: 35, volume48h: 30 },
        { itemId: "handle", name: "Dual Kamas Prime Handle", qty: 2, lowSell: 7, volume48h: 30 },
        { itemId: "bp", name: "Dual Kamas Prime Blueprint", qty: 1, lowSell: 6, volume48h: 30 },
      ],
    },
    DEFAULT_POLICY,
    NOW,
  )!;

  assert.equal(o.buyAt, 90, "70 + 14 + 6 — not the 48 a flat sum would give");
  assert.equal(o.margin, -3, "87 realised against 90 spent");
  assert.deepEqual(rank([o]), [], "a negative edge is never ranked");
});

test("set liquidity is the bottleneck component, not the set", () => {
  const o = scoreSet(
    {
      set: row({ name: "Some Prime Set", lowSell: 200, volume48h: 90 }),
      parts: [
        { itemId: "a", name: "Common Part", qty: 1, lowSell: 40, volume48h: 90 },
        { itemId: "b", name: "Rare Part", qty: 1, lowSell: 40, volume48h: 2 },
      ],
    },
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.equal(o.volume48h, 2, "assembling is only as fast as the rarest component");
  assert.ok(o.rejects.some((r) => r.includes("volume 2")));
});

test("an unpriced component makes the edge unknown, not zero", () => {
  const o = scoreSet(
    {
      set: row({ lowSell: 200 }),
      parts: [
        { itemId: "a", name: "Part A", qty: 1, lowSell: 40, volume48h: 50 },
        { itemId: "b", name: "Part B", qty: 1, lowSell: null, volume48h: 50 },
      ],
    },
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.equal(o.score, 0);
  assert.ok(o.rejects[0]!.includes("unpriced"));
  assert.deepEqual(rank([o]), []);
});

test("a set is sold where sets trade, not where the cheapest seller asks", () => {
  // Aeolak, from a real sweep: 64p of parts, cheapest set ask 248p, trades at
  // 77p. Against the ask it was the best set in the game at +183p.
  const o = scoreSet(
    {
      set: row({ name: "Aeolak Set", lowSell: 248, median7d: 77, volume48h: 8 }),
      parts: [
        { itemId: "stock", name: "Aeolak Stock", qty: 1, lowSell: 12, volume48h: 30 },
        { itemId: "barrel", name: "Aeolak Barrel", qty: 2, lowSell: 26, volume48h: 30 },
      ],
    },
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.equal(o.buyAt, 64);
  assert.equal(o.sellAt, 77, "listed at the traded price, not under a 248p ask");
  assert.equal(o.margin, 13, "not 183");
  assert.deepEqual(o.rejects, [], "a real 13p edge is still an edge");
});

test("a set still undercuts the book when the book is below where it trades", () => {
  assert.equal(setSellPrice(row({ lowSell: 60, median7d: 70 })), 59);
});

test("with no set trade history the set sells just under its cheapest ask", () => {
  assert.equal(setSellPrice(row({ lowSell: 60, median7d: null })), 59);
});

test("ranking prefers realisable platinum over raw margin", () => {
  // Thin but liquid enough to repeat, against fat but capacity-limited.
  const liquid = scoreSpread(
    row({ itemId: "liquid", name: "Liquid", lowSell: 60, highBuy: 45, volume48h: 100 }),
    DEFAULT_POLICY,
    NOW,
  )!;
  const thin = scoreSpread(
    row({ itemId: "thin", name: "Thin", lowSell: 100, highBuy: 88, volume48h: 7 }),
    DEFAULT_POLICY,
    NOW,
  )!;

  const ranked = rank([thin, liquid]);
  assert.equal(ranked[0]!.itemId, "liquid");
  // 13p over 10 capturable trades beats 10p over 7.
  assert.equal(liquid.score, 130);
  assert.equal(thin.score, 70);
});

test("a spread quoted against one lowball bid is not tradable", () => {
  // melee_assimilation: asks from 150p, a single 15p bid. Nobody fills a 16p
  // buy order on a 150p item, so the 173p "spread" does not exist.
  const o = scoreSpread(
    row({
      name: "Melee Assimilation",
      lowSell: 190,
      highBuy: 15,
      sellCount: 5,
      buyCount: 1,
      volume48h: 10,
    }),
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.ok(o.margin > 150, "the arithmetic spread really is large");
  assert.ok(
    o.rejects.some((r) => r.includes("buy orders")),
    `expected a bid-side rejection, got ${JSON.stringify(o.rejects)}`,
  );
  assert.deepEqual(rank([o]), []);
});

test("a spread of a thousand percent is two prices, not one market", () => {
  const o = scoreSpread(
    row({ lowSell: 190, highBuy: 15, sellCount: 5, buyCount: 5 }),
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.ok(
    o.rejects.some((r) => r.includes("not one market")),
    `got ${JSON.stringify(o.rejects)}`,
  );
});

test("an ordinary spread still passes both new checks", () => {
  const o = scoreSpread(row({ lowSell: 60, highBuy: 45, buyCount: 5 }), DEFAULT_POLICY, NOW)!;
  assert.deepEqual(o.rejects, [], "33% spread on a corroborated book is fine");
});

test("a trade needing more capital than you have is held back", () => {
  // Ancient Fusion Core shape: a real 400p edge that ties up 500p.
  // median7d set to match the price level; the fixture default of 62p would
  // make a 900p item look like an ask book detached from reality.
  const rich = row({
    name: "Ancient Fusion Core",
    lowSell: 900,
    highBuy: 500,
    median7d: 700,
    volume48h: 20,
  });
  assert.deepEqual(scoreSpread(rich, DEFAULT_POLICY, NOW)!.rejects, [], "unlimited by default");

  const capped = scoreSpread(rich, { ...DEFAULT_POLICY, maxBuyAt: 200 }, NOW)!;
  assert.ok(
    capped.rejects.some((r) => r.includes("up front")),
    `got ${JSON.stringify(capped.rejects)}`,
  );
  assert.deepEqual(rank([capped]), []);
});

test("sorting by return prefers the cheaper trade with the same edge", () => {
  const cheap = scoreSpread(
    row({ itemId: "cheap", lowSell: 60, highBuy: 45, volume48h: 100 }),
    DEFAULT_POLICY,
    NOW,
  )!;
  const dear = scoreSpread(
    row({ itemId: "dear", lowSell: 620, highBuy: 500, median7d: 600, volume48h: 100 }),
    DEFAULT_POLICY,
    NOW,
  )!;

  // Absolute platinum favours the expensive one.
  assert.equal(rank([cheap, dear], "score")[0]!.itemId, "dear");
  // Return on capital favours the one that frees the money up again.
  assert.equal(rank([cheap, dear], "return")[0]!.itemId, "cheap");
});

test("live freshness survives scoring", () => {
  // The query knows a price came from the live feed; if scoring drops it the UI
  // cannot tell a two-minute-old ask from a twenty-two-minute-old one.
  const fresh = scoreSpread(row({ liveAt: "2026-09-10T11:58:00Z" }), DEFAULT_POLICY, NOW)!;
  assert.equal(fresh.liveAt, "2026-09-10T11:58:00Z");

  const fromSweep = scoreSpread(row(), DEFAULT_POLICY, NOW)!;
  assert.equal(fromSweep.liveAt, null);
});

test("a sell leg far above where the market clears is rejected", () => {
  // Blaze: asks 74p, trades at 47p. Posting at 73p asks half again what anyone
  // pays, so the 31p margin is closer to 5p and only if you wait indefinitely.
  const o = scoreSpread(
    row({ name: "Blaze", lowSell: 74, highBuy: 41, median7d: 47, volume48h: 30 }),
    DEFAULT_POLICY,
    NOW,
  )!;
  assert.equal(o.margin, 31, "the arithmetic margin is real enough");
  assert.ok(
    o.rejects.some((r) => r.includes("where it trades at")),
    `expected a traded-median rejection, got ${JSON.stringify(o.rejects)}`,
  );
  assert.deepEqual(rank([o]), []);
});

test("a sell leg near the traded price passes", () => {
  const o = scoreSpread(row({ lowSell: 60, highBuy: 45, median7d: 58 }), DEFAULT_POLICY, NOW)!;
  assert.deepEqual(o.rejects, [], "asking 59 where it trades at 58 is ordinary");
});

test("with no trade history the sell leg cannot be second-guessed", () => {
  const o = scoreSpread(row({ median7d: null }), DEFAULT_POLICY, NOW)!;
  assert.deepEqual(o.rejects, []);
});
