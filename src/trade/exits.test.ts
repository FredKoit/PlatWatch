import { test } from "node:test";
import assert from "node:assert/strict";
import { exitNotice, exitSignals, type Position, type PositionMarket } from "./exits";
import type { BookOrder } from "../rank/depth";

const order = (platinum: number, quantity: number | null = 1, who = `p${platinum}`): BookOrder => ({
  orderId: `o-${who}`,
  userId: who,
  ingameName: who,
  platinum,
  quantity,
  status: "ingame",
  lastSeen: "2026-09-11T12:00:00Z",
});

const position = (over: Partial<Position> = {}): Position => ({
  tradeId: 1,
  itemId: "i",
  variant: "",
  name: "Rhino Prime Set",
  quantity: 1,
  target: 50,
  heldH: 5,
  ...over,
});

const market = (over: Partial<PositionMarket> = {}): PositionMarket => ({
  bids: [],
  asks: [order(55, 2)],
  expectedDays: 1,
  ...over,
});

const kinds = (p: Position, m: PositionMarket) => exitSignals(p, m).map((s) => s.kind);

test("a buyer bidding at your target means sell now — to them, at their price", () => {
  const [s] = exitSignals(position(), market({ bids: [order(52, 1, "Buyer")] }));
  assert.equal(s!.kind, "target_bid");
  assert.equal(s!.value, 52);
  assert.equal(
    s!.whisper,
    '/w Buyer Hi! I want to sell: "Rhino Prime Set" for 52 platinum. (warframe.market)',
    "filling a buy order is at the bid; offering less throws the edge away",
  );
});

test("a bid below target is not a signal", () => {
  assert.deepEqual(kinds(position(), market({ bids: [order(49)] })), []);
});

test("a bid for fewer units than you hold says so", () => {
  const [s] = exitSignals(position({ quantity: 3 }), market({ bids: [order(55, 1)] }));
  assert.match(s!.detail, /wants 1 of your 3/);
});

test("asks below your target are competition, counted in units", () => {
  const [s] = exitSignals(position(), market({ asks: [order(44, 2), order(48, 1), order(60, 4)] }));
  assert.equal(s!.kind, "undercut");
  assert.equal(s!.value, 44, "fires at the cheapest undercut");
  assert.match(s!.detail, /3 listed below your 50p target/);
});

test("a position that has taken far longer than expected is sitting", () => {
  // Expected ~1 day, held 4: past both the 3-day floor and twice the estimate.
  assert.deepEqual(kinds(position({ heldH: 4 * 24 }), market({ expectedDays: 1 })), ["stale"]);
});

test("a slow item is not flagged merely for being slow", () => {
  // Expected 5 days: holding it 4 is on schedule.
  assert.deepEqual(kinds(position({ heldH: 4 * 24 }), market({ expectedDays: 5 })), []);
  assert.deepEqual(kinds(position({ heldH: 11 * 24 }), market({ expectedDays: 5 })), ["stale"]);
});

test("without a target only the clock can fire", () => {
  const p = position({ target: null, heldH: 10 * 24 });
  assert.deepEqual(kinds(p, market({ bids: [order(999)], asks: [order(1)] })), ["stale"]);
});

test("the notification leads with what to do, and carries the whisper", () => {
  const [s] = exitSignals(position(), market({ bids: [order(52, 1, "Buyer")] }));
  const n = exitNotice("Rhino Prime Set", s!);
  assert.equal(n.title, "Sell Rhino Prime Set now: Buyer bids 52p");
  assert.ok(n.whisper?.includes("for 52 platinum"));
});
