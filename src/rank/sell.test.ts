import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { sellAdvice } from "./sell";
import type { WfmItemSummary } from "../wfm/types";

const nowIso = new Date().toISOString();
const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

const dayOffset = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set")]);
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (1,'top',?,?)").run(
    nowIso,
    nowIso,
  );
  return db;
}

/** Seven days of trading between `lo` and `hi`, clearing around `mid`. */
function history(db: Db, mid: number, lo: number, hi: number, volume = 10) {
  const stmt = db.prepare(
    `INSERT INTO stat_daily (item_id, day, variant, volume, median, min_price, max_price)
     VALUES ('rhino', ?, '', ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 7; i++) stmt.run(dayOffset(i), volume, mid, lo, hi);
}

function book(db: Db, lowSell: number | null) {
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, sell_count, buy_count)
     VALUES ('rhino', 1, '', ?, ?, 5, 5)`,
  ).run(nowIso, lowSell);
}

function ask(db: Db, id: string, platinum: number) {
  db.prepare(
    `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum,
                             variant, created_at, updated_at, first_seen, last_seen,
                             sightings, top_rank, sweeps_at_best)
     VALUES (?, 'rhino', 'u', 'Someone', 'sell', ?, '', ?, ?, ?, ?, 1, 0, 1)`,
  ).run(id, platinum, nowIso, nowIso, nowIso, nowIso);
}

test("the fair price is where it clears, capped by what the book lets you show", () => {
  const db = seeded();
  history(db, 60, 55, 68);
  book(db, 66);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.tradedMedian, 60);
  assert.equal(a.fairPrice, 60, "inside the traded range and under the cheapest ask");
  assert.equal(a.quickPrice, 65, "undercut the book to be seen today");
  assert.equal(a.patientPrice, 68);
  assert.equal(a.bookAboveMarket, false);
  db.close();
});

test("a fair price above the cheapest ask is pulled below it", () => {
  const db = seeded();
  // It normally clears at 60, but someone is already asking 50.
  history(db, 60, 55, 68);
  book(db, 50);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.fairPrice, 49, "being the sixth cheapest ask is the same as not listing");
  db.close();
});

test("a book detached from the traded range is called out", () => {
  const db = seeded();
  // Blaze shape: asks 74, trades at 47.
  history(db, 47, 44, 52);
  book(db, 74);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.bookAboveMarket, true);
  assert.equal(a.quickPrice, 73, "undercutting the book is still above where anyone buys");
  assert.equal(a.fairPrice, 47, "so the honest price is the traded one");
  db.close();
});

test("the queue counts only sellers cheaper than you", () => {
  const db = seeded();
  history(db, 60, 55, 68);
  book(db, 66);
  ask(db, "a", 50);
  ask(db, "b", 55);
  ask(db, "c", 62); // dearer than fair — sells after you, not before
  ask(db, "d", 66);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.fairPrice, 60);
  assert.equal(a.queueAtFair, 2, "only the 50 and 55 clear first");
  db.close();
});

test("the wait is queue depth over daily volume", () => {
  const db = seeded();
  history(db, 60, 55, 68, 4); // 4 a day
  book(db, 66);
  ask(db, "a", 50);
  ask(db, "b", 52);
  ask(db, "c", 54);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.dailyVolume, 4);
  assert.equal(a.queueAtFair, 3);
  assert.equal(a.estimatedDaysAtFair, 1, "you are the 4th unit to move, at 4 a day");
  db.close();
});

test("a dead item gives no estimate rather than a fake one", () => {
  const db = seeded();
  history(db, 60, 55, 68, 0);
  book(db, 66);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.dailyVolume, 0);
  assert.equal(a.estimatedDaysAtFair, null, "no volume means no honest wait to quote");
  db.close();
});

test("with no history the book is all there is", () => {
  const db = seeded();
  book(db, 66);

  const a = sellAdvice(db, "rhino");
  assert.equal(a.daysOfHistory, 0);
  assert.equal(a.tradedMedian, null);
  assert.equal(a.fairPrice, 65, "undercut the book, since nothing else is known");
  assert.equal(a.patientPrice, null);
  db.close();
});

test("with neither book nor history nothing is invented", () => {
  const db = seeded();
  const a = sellAdvice(db, "rhino");
  assert.equal(a.fairPrice, null);
  assert.equal(a.quickPrice, null);
  assert.equal(a.estimatedDaysAtFair, null);
  db.close();
});
