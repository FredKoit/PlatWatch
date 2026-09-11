import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import {
  logWhisper,
  opportunities,
  pendingWhispers,
  resolveWhisper,
  sellerStats,
  setArbitrage,
  setWatched,
  status,
  watchedItems,
} from "./api";
import type { WfmItemSummary } from "../wfm/types";

const item = (id: string, slug: string, tags: string[] = []): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags,
  i18n: { en: { name: slug.replace(/_/g, " ") } },
});

const today = new Date().toISOString().slice(0, 10);
const nowIso = new Date().toISOString();

/** A database with one liquid, two-sided, tradable market. */
function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set", ["set"])]);

  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (1,'top',?,?)").run(
    nowIso,
    nowIso,
  );
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, high_buy,
                           sell_p50_top, sell_count, buy_count, newest_sell_age_h)
     VALUES ('rhino', 1, '', ?, 60, 45, 66, 5, 5, 2)`,
  ).run(nowIso);
  db.prepare(
    `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d,
                               volume_30d, median_7d, median_30d, days_traded_30d, last_traded_day)
     VALUES ('rhino', '', ?, 104, 400, 1600, 62, 60, 30, ?)`,
  ).run(nowIso, today);

  const order = (id: string, type: string, plat: number, user: string) =>
    db
      .prepare(
        `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum,
                                 variant, created_at, updated_at, first_seen, last_seen,
                                 sightings, top_rank, sweeps_at_best)
         VALUES (?, 'rhino', ?, ?, ?, ?, '', ?, ?, ?, ?, 1, 0, 1)`,
      )
      .run(id, user, user, type, plat, nowIso, nowIso, nowIso, nowIso);

  order("sell-cheap", "sell", 60, "CheapSeller");
  order("sell-dear", "sell", 70, "DearSeller");
  order("buy-high", "buy", 45, "TopBidder");
  return db;
}

test("a spread is executed by posting orders, not by paying the ask", () => {
  const db = seeded();
  const r = opportunities(db)[0]!;

  assert.equal(r.kind, "spread");
  assert.equal(r.playKind, "post");
  // Best bid 45, best ask 60 → bid 46, ask 59, keeping 13.
  assert.equal(r.postBuyAt, 46);
  assert.equal(r.postSellAt, 59);
  assert.equal(r.margin, 13);

  // The whisper offers the model's buy price, not the seller's 60p ask.
  // Paying 60 and then selling at 59 is a loss, which is what offering the
  // asking price used to invite.
  assert.equal(
    r.lowballWhisper,
    '/w CheapSeller Hi! I want to buy: "rhino prime set" for 46 platinum. (warframe.market)',
  );
  assert.ok(
    !r.lowballWhisper!.includes("for 60 platinum"),
    "never offer the ask on a spread",
  );
  assert.equal(r.seller?.ingameName, "CheapSeller", "still shown, as the lowball target");
  assert.equal(r.parts, null);
  db.close();
});

test("the offered price never exceeds what the trade can bear", () => {
  const db = seeded();
  const r = opportunities(db)[0]!;
  const offered = Number(r.lowballWhisper!.match(/for (\d+) platinum/)![1]);
  assert.ok(
    offered < r.postSellAt!,
    `offering ${offered} while planning to sell at ${r.postSellAt} would lose money`,
  );
  db.close();
});

test("orders that left the book are never offered as counterparties", () => {
  const db = seeded();
  db.prepare("UPDATE order_seen SET left_top_at = ? WHERE order_id = 'sell-cheap'").run(nowIso);

  const r = opportunities(db)[0]!;
  assert.equal(r.seller?.ingameName, "DearSeller", "falls through to the next live ask");
  db.close();
});

test("reply rate is built from your own whisper log", () => {
  const db = seeded();

  const a = logWhisper(db, {
    itemId: "rhino",
    userId: "CheapSeller",
    ingameName: "CheapSeller",
    platinum: 60,
  });
  const b = logWhisper(db, {
    itemId: "rhino",
    userId: "CheapSeller",
    ingameName: "CheapSeller",
    platinum: 60,
  });
  resolveWhisper(db, a, { replied: true, traded: true });
  resolveWhisper(db, b, { replied: false });

  const stats = sellerStats(db);
  assert.deepEqual(stats.get("CheapSeller"), { sent: 2, replied: 1 });

  const r = opportunities(db)[0]!;
  assert.equal(r.seller?.sent, 2);
  assert.equal(r.seller?.replyRate, 0.5, "surfaced on the row so you can prefer repliers");
  db.close();
});

test("an unresolved whisper counts as sent but not replied", () => {
  const db = seeded();
  logWhisper(db, { itemId: "rhino", userId: "u", ingameName: "Someone", platinum: 60 });
  assert.deepEqual(sellerStats(db).get("u"), { sent: 1, replied: 0 });

  const pending = pendingWhispers(db) as Array<{ replied: number | null; item_name: string }>;
  assert.equal(pending[0]!.replied, null, "null means still waiting, not refused");
  assert.equal(pending[0]!.item_name, "rhino prime set");
  db.close();
});

test("the watchlist filters and drives the frequent re-poll", () => {
  const db = seeded();
  assert.deepEqual(opportunities(db, { watchedOnly: true }), []);

  setWatched(db, "rhino", "", true);
  assert.equal(opportunities(db, { watchedOnly: true }).length, 1);
  assert.equal(opportunities(db)[0]!.watched, true);
  assert.deepEqual(
    watchedItems(db).map((i) => i.slug),
    ["rhino_prime_set"],
  );

  setWatched(db, "rhino", "", false);
  assert.deepEqual(opportunities(db, { watchedOnly: true }), []);
  db.close();
});

test("watching is idempotent", () => {
  const db = seeded();
  setWatched(db, "rhino", "", true);
  setWatched(db, "rhino", "", true);
  assert.equal(watchedItems(db).length, 1);
  db.close();
});

test("status reports how old the prices are", () => {
  const db = seeded();
  const s = status(db);
  assert.equal(s.sweepId, 1);
  assert.equal(s.markets, 1);
  assert.equal(s.ordersTracked, 3);
  assert.ok(s.sweepAgeH !== null && s.sweepAgeH < 1);
  db.close();
});

test("set arbitrage offers each component's seller, not the set's", () => {
  const db = openDb(":memory:");
  upsertCatalog(db, [
    item("kamas", "dual_kamas_prime_set", ["set"]),
    item("blade", "dual_kamas_prime_blade"),
    item("handle", "dual_kamas_prime_handle"),
  ]);
  db.prepare("UPDATE item SET set_root = 1 WHERE id = 'kamas'").run();
  db.prepare("INSERT INTO item_part VALUES ('kamas','blade',2),('kamas','handle',2)").run();
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (1,'top',?,?)").run(
    nowIso,
    nowIso,
  );

  const snap = (id: string, low: number, p50: number) =>
    db
      .prepare(
        `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, high_buy,
                               sell_p50_top, sell_count, buy_count, newest_sell_age_h)
         VALUES (?, 1, '', ?, ?, NULL, ?, 5, 0, 2)`,
      )
      .run(id, nowIso, low, p50);
  snap("kamas", 200, 210);
  snap("blade", 30, 32);
  snap("handle", 20, 22);

  const stat = (id: string, median: number) =>
    db
      .prepare(
        `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d,
                                   volume_30d, median_7d, median_30d, days_traded_30d, last_traded_day)
         VALUES (?, '', ?, 50, 200, 800, ?, ?, 30, ?)`,
      )
      .run(id, nowIso, median, median, today);
  stat("kamas", 200);
  stat("blade", 30);
  stat("handle", 20);

  const ord = (oid: string, item: string, plat: number, who: string) =>
    db
      .prepare(
        `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum,
                                 variant, created_at, updated_at, first_seen, last_seen,
                                 sightings, top_rank, sweeps_at_best)
         VALUES (?, ?, ?, ?, 'sell', ?, '', ?, ?, ?, ?, 1, 0, 1)`,
      )
      .run(oid, item, who, who, plat, nowIso, nowIso, nowIso, nowIso);
  ord("o-set", "kamas", 200, "SetSeller");
  ord("o-blade", "blade", 30, "BladeGuy");
  ord("o-handle", "handle", 20, "HandleGal");

  const r = opportunities(db).find((x) => x.kind === "set")!;
  assert.equal(r.playKind, "buy-parts");
  // 30x2 + 20x2 = 100 against a 199p realisation.
  assert.equal(r.buyAt, 100);
  assert.equal(r.postBuyAt, null, "there is no order to post for this play");

  const names = r.parts!.map((p) => p.seller?.ingameName);
  assert.deepEqual(names, ["BladeGuy", "HandleGal"]);
  assert.ok(
    !names.includes("SetSeller"),
    "you assemble the set — you never buy it from the person selling it",
  );
  assert.equal(r.parts![0]!.qty, 2, "quantity carried so you know to buy two");
  assert.ok(r.parts![0]!.whisper!.includes("dual kamas prime blade"));
  assert.ok(r.parts![0]!.whisper!.includes("for 30 platinum"));
  db.close();
});

interface SetSpec {
  id: string;
  ask: number;
  traded: number | null;
  volume?: number;
  /** A part with a null ask has no order anywhere, so it is unpriced. */
  parts: Array<{ id: string; qty: number; ask: number | null }>;
}

/** One finished sweep holding these sets, each priced part with a live seller at its ask. */
function setsDb(specs: SetSpec[]): Db {
  const db = openDb(":memory:");
  upsertCatalog(
    db,
    specs.flatMap((s) => [
      item(s.id, `${s.id}_set`, ["set"]),
      ...s.parts.map((p) => item(p.id, `${s.id}_${p.id}`)),
    ]),
  );
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (1,'top',?,?)").run(
    nowIso,
    nowIso,
  );

  const snap = db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, high_buy,
                           sell_p50_top, sell_count, buy_count, newest_sell_age_h)
     VALUES (?, 1, '', ?, ?, NULL, ?, 5, 0, 2)`,
  );
  const stat = db.prepare(
    `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d,
                               volume_30d, median_7d, median_30d, days_traded_30d, last_traded_day)
     VALUES (?, '', ?, ?, 200, 800, ?, ?, 30, ?)`,
  );
  const sell = db.prepare(
    `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum,
                             variant, created_at, updated_at, first_seen, last_seen,
                             sightings, top_rank, sweeps_at_best)
     VALUES (?, ?, ?, ?, 'sell', ?, '', ?, ?, ?, ?, 1, 0, 1)`,
  );

  for (const s of specs) {
    db.prepare("UPDATE item SET set_root = 1 WHERE id = ?").run(s.id);
    snap.run(s.id, nowIso, s.ask, s.ask);
    stat.run(s.id, nowIso, s.volume ?? 50, s.traded, s.traded, today);
    for (const p of s.parts) {
      db.prepare("INSERT INTO item_part VALUES (?, ?, ?)").run(s.id, p.id, p.qty);
      stat.run(p.id, nowIso, 50, p.ask, p.ask, today);
      if (p.ask === null) continue;
      snap.run(p.id, nowIso, p.ask, p.ask);
      const who = `${p.id}Seller`;
      sell.run(`o-${p.id}`, p.id, who, who, p.ask, nowIso, nowIso, nowIso, nowIso);
    }
  }
  return db;
}

test("a set's parts are itemised, and add up to what the set costs", () => {
  const db = setsDb([
    {
      id: "kamas",
      ask: 120,
      traded: 120,
      parts: [
        { id: "blade", qty: 2, ask: 30 },
        { id: "handle", qty: 2, ask: 10 },
        { id: "kbp", qty: 1, ask: 15 },
      ],
    },
  ]);
  const r = setArbitrage(db).rows[0]!;

  assert.deepEqual(
    r.parts.map((p) => [p.name, p.qty, p.each, p.subtotal]),
    [
      ["kamas blade", 2, 30, 60],
      ["kamas handle", 2, 10, 20],
      ["kamas kbp", 1, 15, 15],
    ],
  );
  assert.equal(r.buyAt, 95, "30×2 + 10×2 + 15");
  assert.equal(
    r.parts.reduce((n, p) => n + p.subtotal!, 0),
    r.buyAt,
    "the lines shown are exactly the total compared",
  );
  assert.equal(r.sellAt, 119);
  assert.equal(r.margin, 24);

  // Each line is bought from that part's own seller, at that seller's ask.
  assert.equal(r.parts[0]!.seller?.ingameName, "bladeSeller");
  assert.ok(r.parts[0]!.whisper!.includes('"kamas blade" for 30 platinum'));
  db.close();
});

test("a set is compared against where sets trade, and says when that cut the edge", () => {
  const db = setsDb([
    // Aeolak's shape: asks 248p, trades at 77p.
    { id: "aeolak", ask: 248, traded: 77, parts: [
      { id: "stock", qty: 1, ask: 12 },
      { id: "barrel", qty: 2, ask: 26 },
    ] },
    { id: "rhino", ask: 100, traded: 110, parts: [{ id: "chassis", qty: 1, ask: 60 }] },
  ]);
  const byName = new Map(setArbitrage(db).rows.map((r) => [r.name, r]));

  const aeolak = byName.get("aeolak set")!;
  assert.equal(aeolak.setAsk, 248, "the ask is still shown");
  assert.equal(aeolak.tradedAt, 77);
  assert.equal(aeolak.sellAt, 77);
  assert.equal(aeolak.margin, 13, "not the 183 a sum against the ask promises");
  assert.equal(aeolak.cappedByTrades, true);

  const rhino = byName.get("rhino set")!;
  assert.equal(rhino.sellAt, 99, "below the traded price, so the book decides");
  assert.equal(rhino.cappedByTrades, false);
  db.close();
});

test("sets rank by profit per set unless asked for return on capital", () => {
  const db = setsDb([
    // 40p on 200p of parts, against 15p on 20p.
    { id: "big", ask: 241, traded: 250, parts: [{ id: "bigpart", qty: 1, ask: 200 }] },
    { id: "small", ask: 36, traded: 40, parts: [{ id: "smallpart", qty: 1, ask: 20 }] },
  ]);
  assert.deepEqual(setArbitrage(db).rows.map((r) => r.name), ["big set", "small set"]);
  assert.deepEqual(
    setArbitrage(db, { sortBy: "return" }).rows.map((r) => r.name),
    ["small set", "big set"],
  );
  db.close();
});

test("held-back sets are listed only on request, after the tradable ones, with reasons", () => {
  const db = setsDb([
    { id: "good", ask: 100, traded: 100, parts: [{ id: "g1", qty: 1, ask: 60 }] },
    { id: "dead", ask: 200, traded: 200, volume: 1, parts: [{ id: "d1", qty: 1, ask: 60 }] },
    { id: "loss", ask: 81, traded: 80, parts: [{ id: "l1", qty: 1, ask: 100 }] },
    { id: "mystery", ask: 300, traded: 300, parts: [
      { id: "m1", qty: 1, ask: 10 },
      { id: "m2", qty: 1, ask: null },
    ] },
  ]);

  const plain = setArbitrage(db);
  assert.deepEqual(plain.rows.map((r) => r.name), ["good set"]);
  assert.equal(plain.tradable, 1);
  assert.equal(plain.priced, 3, "every set but the one with an unpriced part");

  const all = setArbitrage(db, { includeHeldBack: true }).rows;
  assert.deepEqual(
    all.map((r) => r.name),
    ["good set", "dead set", "loss set", "mystery set"],
    "the fattest held-back edge is often the trap, so it leads that group; unknown edges go last",
  );
  const dead = all[1]!;
  assert.ok(dead.margin > 100, "the edge is real arithmetic");
  assert.ok(dead.rejects.some((x) => x.includes("volume 1")), `got ${JSON.stringify(dead.rejects)}`);
  assert.ok(all[2]!.margin < 0);

  const mystery = all[3]!;
  assert.equal(mystery.unpriced, 1);
  assert.ok(mystery.rejects[0]!.includes("unpriced"));
  assert.equal(mystery.parts.find((p) => p.each === null)?.subtotal, null);
  db.close();
});

test("the capital cap holds back sets whose parts cost more than you have", () => {
  const db = setsDb([
    { id: "big", ask: 241, traded: 250, parts: [{ id: "bigpart", qty: 1, ask: 200 }] },
    { id: "small", ask: 36, traded: 40, parts: [{ id: "smallpart", qty: 1, ask: 20 }] },
  ]);
  assert.deepEqual(
    setArbitrage(db, { maxBuyAt: 100 }).rows.map((r) => r.name),
    ["small set"],
  );
  const big = setArbitrage(db, { maxBuyAt: 100, includeHeldBack: true }).rows.find(
    (r) => r.name === "big set",
  )!;
  assert.ok(big.rejects.some((x) => x.includes("up front")), `got ${JSON.stringify(big.rejects)}`);
  db.close();
});
