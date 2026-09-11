import { test } from "node:test";
import assert from "node:assert/strict";
import { fillFromBook, unitsBelow, type BookOrder } from "./depth";

const ask = (platinum: number, quantity: number | null, who = `s${platinum}`): BookOrder => ({
  orderId: `o-${who}-${platinum}`,
  userId: who,
  ingameName: who,
  platinum,
  quantity,
  status: "ingame",
  lastSeen: "2026-09-11T12:00:00Z",
});

test("two units from a seller holding one cost the next ask up, not twice the cheapest", () => {
  // Dual-wield parts: the set needs two blades and the cheapest seller has one.
  const r = fillFromBook([ask(30, 1), ask(34, 3)], 2);
  assert.equal(r.cost, 64, "30 + 34 — the flat 30×2 = 60 was never buyable");
  assert.equal(r.available, 2);
  assert.deepEqual(r.fills.map((f) => [f.order.platinum, f.units]), [[30, 1], [34, 1]]);
});

test("a seller holding enough fills the whole quantity alone", () => {
  const r = fillFromBook([ask(30, 5), ask(31, 5)], 2);
  assert.equal(r.cost, 60);
  assert.equal(r.fills.length, 1, "one whisper, not two");
});

test("a book too thin to fill the quantity has no cost, and says how short it is", () => {
  const r = fillFromBook([ask(30, 1)], 2);
  assert.equal(r.cost, null, "half a set is not a set");
  assert.equal(r.available, 1);
});

test("an order of unknown quantity counts as one unit", () => {
  // Rows recorded before quantities were kept. Assuming more could price a
  // two-part need off a seller who holds one; one can only overstate the cost.
  const r = fillFromBook([ask(30, null), ask(40, null)], 2);
  assert.equal(r.cost, 70);
});

test("the book is walked cheapest first, whatever order it arrives in", () => {
  const r = fillFromBook([ask(50, 1), ask(30, 1), ask(40, 1)], 2);
  assert.equal(r.cost, 70);
});

test("the queue ahead counts units, not orders", () => {
  const book = [ask(40, 3), ask(44, 1), ask(50, 2)];
  assert.equal(unitsBelow(book, 45), 4, "three at 40 and one at 44 sell before a 45p listing");
  assert.equal(unitsBelow(book, 40), 0, "an equal price is not ahead of you");
});
