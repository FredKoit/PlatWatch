import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALERT_POLICY, detect, whisperFor, type Baseline } from "./detect";
import type { UserStatus, WfmOrder } from "../wfm/types";

const NOW = Date.parse("2026-09-10T12:00:00Z");

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  itemId: "rhino",
  slug: "rhino_prime_set",
  name: "Rhino Prime Set",
  variant: "",
  fairValue: 66,
  median7d: 64,
  lowSell: 60,
  volume48h: 104,
  lastTradedDay: "2026-09-10",
  snapshotAt: "2026-09-10T10:00:00Z",
  ...over,
});

const order = (
  over: Partial<WfmOrder> = {},
  status: UserStatus = "ingame",
): WfmOrder => ({
  id: "o1",
  type: "sell",
  platinum: 40,
  quantity: 1,
  perTrade: 1,
  visible: true,
  createdAt: "2026-09-10T11:59:00Z",
  updatedAt: "2026-09-10T11:59:00Z",
  itemId: "rhino",
  user: {
    id: "u1",
    ingameName: "Tenno123",
    slug: "tenno123",
    reputation: 42,
    platform: "pc",
    crossplay: true,
    locale: "en",
    status,
  },
  ...over,
});

test("a sell well under fair value fires, with a pasteable whisper", () => {
  const a = detect(order(), baseline(), DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.kind, "underpriced_sell");
  // Worth the lower of the asks median (66) and the traded median (64) — but a
  // seller already asks 60, so the resale has to be 59. This used to claim 24.
  assert.equal(a.reference, 59);
  assert.equal(a.profit, 19);
  assert.equal(
    a.whisper,
    '/w Tenno123 Hi! I want to buy: "Rhino Prime Set" for 40 platinum. (warframe.market)',
  );
  assert.equal(a.suspicious, false);
});

test("a sell near fair value is ignored", () => {
  assert.equal(detect(order({ platinum: 58 }), baseline(), DEFAULT_ALERT_POLICY, NOW), null);
});

test("a buy well above the live ask fires as an instant flip", () => {
  // Someone bids 95 while the market asks 60: buy at 60, fill them at 95.
  const a = detect(order({ type: "buy", platinum: 95 }), baseline(), DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.kind, "overpriced_buy");
  assert.equal(a.reference, 60, "judged against the ask, not the median");
  assert.equal(a.profit, 35);
  assert.equal(
    a.whisper,
    '/w Tenno123 Hi! I want to sell: "Rhino Prime Set" for 95 platinum. (warframe.market)',
  );
});

test("a buy at the going rate is ignored", () => {
  assert.equal(
    detect(order({ type: "buy", platinum: 62 }), baseline(), DEFAULT_ALERT_POLICY, NOW),
    null,
  );
});

test("an offline seller is not actionable", () => {
  assert.equal(detect(order({}, "offline"), baseline(), DEFAULT_ALERT_POLICY, NOW), null);
});

test("an illiquid item never alerts, however large the discount", () => {
  const a = detect(
    order({ platinum: 5 }),
    baseline({ volume48h: 1, fairValue: 600 }),
    DEFAULT_ALERT_POLICY,
    NOW,
  );
  assert.equal(a, null, "a 595p 'profit' on something nobody trades is not a trade");
});

test("a stale baseline is not a price", () => {
  const a = detect(
    order(),
    baseline({ snapshotAt: "2026-09-08T00:00:00Z" }), // 60h old
    DEFAULT_ALERT_POLICY,
    NOW,
  );
  assert.equal(a, null);
});

test("an item whose history stopped is skipped", () => {
  assert.equal(
    detect(order(), baseline({ lastTradedDay: "2026-09-05" }), DEFAULT_ALERT_POLICY, NOW),
    null,
  );
});

test("an absurd discount fires but is flagged suspicious", () => {
  // 5p against a 66p median: more often a typo or bait than a bargain.
  const a = detect(order({ platinum: 5 }), baseline(), DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.suspicious, true, "worth seeing, worth doubting — judged against its 64p worth");
  assert.equal(a.profit, 54, "5p, resold under the 60p already listed");
});

test("an invisible order is skipped", () => {
  assert.equal(detect(order({ visible: false }), baseline(), DEFAULT_ALERT_POLICY, NOW), null);
});

test("an item with no baseline is skipped", () => {
  assert.equal(detect(order(), undefined, DEFAULT_ALERT_POLICY, NOW), null);
});

test("whisper format matches the site's own", () => {
  assert.equal(
    whisperFor("Player", "Vectis Prime Set", 120, "buy"),
    '/w Player Hi! I want to buy: "Vectis Prime Set" for 120 platinum. (warframe.market)',
  );
});

test("a rank-10 buy order is not judged against a rank-0 ask", () => {
  // The bug this exists to prevent: Archon Vitality sells at 20p unranked and
  // has 85p buy orders for the maxed version. Those are different goods, and
  // treating them as one market invented a 325% "profit".
  const rank0Baseline = baseline({
    itemId: "archon_vitality",
    slug: "archon_vitality",
    name: "Archon Vitality",
    variant: "r0",
    lowSell: 20,
    fairValue: 24,
  });
  const rank10Buy = order({ type: "buy", platinum: 85, rank: 10, subtype: "regular" });

  assert.equal(
    detect(rank10Buy, rank0Baseline, DEFAULT_ALERT_POLICY, NOW),
    null,
    "a maxed mod must never be priced off the unranked market",
  );
});

test("a matching variant still alerts normally", () => {
  const b = baseline({ variant: "r0", lowSell: 20, fairValue: 24 });
  const sameVariant = order({ platinum: 10, rank: 0 });
  const a = detect(sameVariant, b, { ...DEFAULT_ALERT_POLICY, minProfit: 5 }, NOW)!;
  assert.equal(a.variant, "r0");
  assert.equal(a.profit, 9, "worth 24p, but a 20p ask means reselling at 19p");
});

test("relic subtypes are separate markets", () => {
  const intact = baseline({ variant: "intact", lowSell: 35, fairValue: 37 });
  const radiantBuy = order({ type: "buy", platinum: 36, subtype: "radiant" });
  assert.equal(detect(radiantBuy, intact, DEFAULT_ALERT_POLICY, NOW), null);
});

test("a bid-only variant is priced from completed trades", () => {
  // A rank-10 mod never shows an ask in /top, because the five cheapest asks
  // are always rank 0. Its traded median is the only price it has.
  const maxedMod = baseline({
    name: "Archon Vitality",
    variant: "r10",
    fairValue: null,
    median7d: 92,
    lowSell: null,
    volume48h: 40,
  });
  const cheapListing = order({ platinum: 60, rank: 10 });

  const a = detect(cheapListing, maxedMod, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.reference, 92, "priced off what it actually traded at");
  assert.equal(a.profit, 32);
});

test("with no ask median and no trade history there is no price", () => {
  const b = baseline({ fairValue: null, median7d: null });
  assert.equal(detect(order(), b, DEFAULT_ALERT_POLICY, NOW), null);
});

test("a buy judged against an anomalous ask is flagged, not trusted", () => {
  // Zid-an Uskos r5: a lone 1p listing against bids near 31p and a ~28p median.
  // The trade may be real; the certainty is not.
  const b = baseline({
    name: "Zid-an Uskos",
    variant: "r5",
    lowSell: 1,
    fairValue: null,
    median7d: 28,
    volume48h: 13,
  });
  const bid = order({ type: "buy", platinum: 31, rank: 5 });

  const a = detect(bid, b, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.kind, "overpriced_buy");
  assert.equal(a.profit, 30, "still reported — sniping lives on exactly this");
  assert.equal(a.suspicious, true, "but the ask is far below what the item trades at");
});

test("a buy against a credible ask is not flagged", () => {
  const b = baseline({ lowSell: 60, median7d: 62 });
  const a = detect(order({ type: "buy", platinum: 95 }), b, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.suspicious, false);
});

test("with no traded median there is nothing to sanity-check against", () => {
  const b = baseline({ lowSell: 1, median7d: null });
  const a = detect(order({ type: "buy", platinum: 31 }), b, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.suspicious, false, "absence of evidence is not evidence of fraud");
});

test("an inflated ask book cannot manufacture a bargain", () => {
  // Nagantaka Prime Blueprint: asks median 60p, actually trades at 14.5p.
  // A 35p listing is not a bargain — it is well above what anyone pays.
  const inflated = baseline({
    name: "Nagantaka Prime Blueprint",
    fairValue: 60,
    median7d: 14.5,
    volume48h: 30,
  });
  assert.equal(
    detect(order({ platinum: 35 }), inflated, DEFAULT_ALERT_POLICY, NOW),
    null,
    "sellers can ask anything; only completed trades say what it is worth",
  );
});

test("a genuinely cheap listing still fires, priced off trades", () => {
  const inflated = baseline({ fairValue: 60, median7d: 14.5, volume48h: 30 });
  const a = detect(order({ platinum: 3 }), inflated, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.reference, 14.5, "judged against what it trades at, not the ask book");
  assert.equal(a.profit, 11.5);
  assert.equal(a.suspicious, true, "and the detached book is itself a warning");
});

test("a healthy book uses the lowest of worth and the cheapest ask, conservatively", () => {
  const healthy = baseline({ fairValue: 66, median7d: 62, lowSell: null });
  const a = detect(order({ platinum: 40 }), healthy, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.reference, 62, "the traded median is the safer of the two medians");
  assert.equal(a.profit, 22);
  assert.equal(a.suspicious, false);
});

test("with no trade history the ask median is all there is", () => {
  const b = baseline({ fairValue: 66, median7d: null, lowSell: null });
  const a = detect(order({ platinum: 40 }), b, DEFAULT_ALERT_POLICY, NOW)!;
  assert.equal(a.reference, 66);
});

test("a listing under the median is no bargain when someone already asks less", () => {
  // Volt Prime Neuroptics BP, from the real alert log: fired at 35p "under a
  // 45p median" while a 15p ask sat on the book. Buying it loses 20p.
  const volt = baseline({ name: "Volt Prime Neuroptics Blueprint", fairValue: 45, median7d: 45, lowSell: 15 });
  assert.equal(detect(order({ platinum: 35 }), volt, DEFAULT_ALERT_POLICY, NOW), null);
});

test("a listing at the cheapest ask is no bargain either", () => {
  assert.equal(detect(order({ platinum: 40 }), baseline(), DEFAULT_ALERT_POLICY, NOW, 40), null);
});

test("an edge that only exists against the median is not reported", () => {
  // Worth 64p, listed at 40p, but a 48p seller caps the resale at 47p: 7p is
  // under the 10p floor, so the "24p find" never fires.
  assert.equal(detect(order({ platinum: 40 }), baseline(), DEFAULT_ALERT_POLICY, NOW, 48), null);
});

test("the caller's competing ask replaces the baseline's", () => {
  // The watcher passes the book as it stood before the batch: the baseline it
  // reloads afterwards may list this very order as the cheapest ask.
  const b = baseline({ lowSell: 40 });
  assert.equal(detect(order({ platinum: 40 }), b, DEFAULT_ALERT_POLICY, NOW), null, "its own ask, by default");
  const a = detect(order({ platinum: 40 }), b, DEFAULT_ALERT_POLICY, NOW, 60)!;
  assert.equal(a.reference, 59);
});

test("a buy is still judged against the ask it would be sourced at", () => {
  // The competing ask is a sell-side idea; a bid alert is unchanged by it.
  const a = detect(order({ type: "buy", platinum: 95 }), baseline(), DEFAULT_ALERT_POLICY, NOW, 1)!;
  assert.equal(a.reference, 60);
});
