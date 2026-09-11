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
  priceHistory,
  setArbitrage,
  setWatched,
  status,
  tradePlan,
  watchedItems,
} from "./api";
import { closeTrade, listTrades, openTrade, setTradeTarget } from "../trade/journal";
import { evaluatePositions, openPositions, unsentSignals } from "../trade/exits";
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

  // Every order carries its quantity; these sellers each hold enough for a set.
  const ord = (oid: string, item: string, plat: number, who: string) =>
    db
      .prepare(
        `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum,
                                 variant, created_at, updated_at, first_seen, last_seen,
                                 sightings, top_rank, sweeps_at_best, quantity, user_status)
         VALUES (?, ?, ?, ?, 'sell', ?, '', ?, ?, ?, ?, 1, 0, 1, 5, 'ingame')`,
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
  /**
   * A part with a null ask has no order anywhere, so it is unpriced. `units` is
   * how many the seller holds (default 5, enough for any set); `more` adds
   * further sellers up the book.
   */
  parts: Array<{
    id: string;
    qty: number;
    ask: number | null;
    units?: number;
    more?: Array<{ ask: number; units: number; status?: string; feedOnly?: boolean }>;
  }>;
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
                             sightings, top_rank, sweeps_at_best, quantity, user_status)
     VALUES (?, ?, ?, ?, 'sell', ?, '', ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
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
      sell.run(`o-${p.id}`, p.id, who, who, p.ask, nowIso, nowIso, nowIso, nowIso, 0, p.units ?? 5, "ingame");
      (p.more ?? []).forEach((m, k) => {
        const other = `${p.id}Seller${k + 2}`;
        // A feed-only sighting has no book position — and an old one no longer counts.
        const seen = m.feedOnly ? new Date(Date.now() - 3_600_000).toISOString() : nowIso;
        sell.run(`o-${p.id}-${k}`, p.id, other, other, m.ask, seen, seen, seen, seen,
          m.feedOnly ? null : k + 1, m.units, m.status ?? "ingame");
      });
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

// ── what you can actually buy ───────────────────────────────────────────────

test("a part the cheapest seller cannot supply in full is bought up the book", () => {
  // Two blades needed; the cheapest seller holds one, the next asks 34p.
  const db = setsDb([
    {
      id: "kamas",
      ask: 150,
      traded: 150,
      parts: [
        { id: "blade", qty: 2, ask: 30, units: 1, more: [{ ask: 34, units: 3 }] },
        { id: "handle", qty: 1, ask: 20 },
      ],
    },
  ]);
  const r = setArbitrage(db).rows[0]!;
  const blade = r.parts.find((p) => p.name === "kamas blade")!;
  assert.equal(blade.subtotal, 64, "30 + 34, not the unbuyable 30 × 2");
  assert.equal(r.buyAt, 84, "the set's cost is what the book actually charges");
  assert.equal(r.parts.reduce((n, p) => n + p.subtotal!, 0), r.buyAt, "and the lines still add up");
  assert.deepEqual(
    blade.fills.map((f) => [f.seller.ingameName, f.units, f.platinum]),
    [["bladeSeller", 1, 30], ["bladeSeller2", 1, 34]],
    "two sellers, one whisper each",
  );
  assert.ok(blade.fills[1]!.whisper.includes("for 34 platinum"));
  db.close();
});

test("a set whose parts cannot be bought in full is held back as short, not priced", () => {
  const db = setsDb([
    { id: "kamas", ask: 150, traded: 150, parts: [{ id: "blade", qty: 2, ask: 30, units: 1 }] },
  ]);
  assert.equal(setArbitrage(db).rows.length, 0, "never offered as tradable");
  const r = setArbitrage(db, { includeHeldBack: true }).rows[0]!;
  assert.equal(r.unpriced, 1);
  assert.ok(r.rejects.some((x) => x.includes("only 1 of 2 kamas blade")), `got ${JSON.stringify(r.rejects)}`);
  assert.equal(r.parts[0]!.available, 1);
  assert.equal(r.parts[0]!.subtotal, null);
  db.close();
});

test("an offline seller, or a feed sighting past its window, is neither priced nor offered", () => {
  // Cheaper asks exist, but one owner is offline and the other was only seen
  // on the feed an hour ago — the kind of row that used to be offered.
  const db = setsDb([
    {
      id: "rhino",
      ask: 100,
      traded: 100,
      parts: [
        {
          id: "chassis",
          qty: 1,
          ask: 60,
          more: [
            { ask: 20, units: 1, status: "offline" },
            { ask: 25, units: 1, feedOnly: true },
          ],
        },
      ],
    },
  ]);
  const part = setArbitrage(db).rows[0]!.parts[0]!;
  assert.equal(part.each, 60);
  assert.equal(part.seller?.ingameName, "chassisSeller");
  db.close();
});

// ── the budget plan ─────────────────────────────────────────────────────────

test("the plan fits the ranked trades to your budget, one per item, within the per-item limit", () => {
  const db = setsDb([
    { id: "big", ask: 241, traded: 250, parts: [{ id: "bigpart", qty: 1, ask: 200 }] },
    { id: "mid", ask: 101, traded: 100, parts: [{ id: "midpart", qty: 1, ask: 70 }] },
    { id: "small", ask: 36, traded: 40, parts: [{ id: "smallpart", qty: 1, ask: 20 }] },
  ]);
  const p = tradePlan(db, { budget: 120, maxPerItem: 150, sortBy: "profit", minConfidence: "low" });
  assert.deepEqual(p.picks.map((x) => x.name), ["mid set", "small set"]);
  assert.equal(p.spent, 90);
  assert.equal(p.skipped.overCap, 1, "the 200p set breaks the per-item limit");
  assert.ok(p.picks[0]!.parts, "picks are full rows: the shopping list comes with them");
  db.close();
});

test("the plan counts what you already hold against an item's limit", () => {
  const db = setsDb([
    { id: "mid", ask: 101, traded: 100, parts: [{ id: "midpart", qty: 1, ask: 70 }] },
  ]);
  openTrade(db, { itemId: "mid", buyPrice: 90, source: "set" });
  const p = tradePlan(db, { budget: 500, maxPerItem: 150, minConfidence: "low" });
  assert.equal(p.picks.length, 0, "90p already in it; another 70p would make 160p");
  assert.equal(p.skipped.held, 1);
  db.close();
});

// ── results-based ranking ───────────────────────────────────────────────────

test("your closed trades re-rank a strategy, and every row says by how much", () => {
  const db = setsDb([
    { id: "big", ask: 241, traded: 250, parts: [{ id: "bigpart", qty: 1, ask: 200 }] },
  ]);
  const before = opportunities(db)[0]!;
  assert.equal(before.calibration, null, "no record, no adjustment");
  assert.equal(before.expectedMargin, before.margin);

  // Ten set trades that each made half of what was predicted.
  for (let i = 0; i < 10; i++) {
    const id = openTrade(db, { itemId: "big", buyPrice: 200, expectedSell: 240, expectedMargin: 40, source: "set" });
    closeTrade(db, id, { sellPrice: 220 });
  }
  const after = opportunities(db)[0]!;
  assert.equal(after.calibration?.factor, 0.75, "halfway to the realised 0.5, at ten trades");
  assert.equal(after.expectedMargin, 30);
  assert.equal(after.margin, 40, "the prediction itself is left alone");
  db.close();
});

// ── exits ───────────────────────────────────────────────────────────────────

test("an open position carries its exit signals, and each is sent once", () => {
  const db = setsDb([
    { id: "rhino", ask: 100, traded: 100, parts: [{ id: "chassis", qty: 1, ask: 60 }] },
  ]);
  const id = openTrade(db, { itemId: "rhino", buyPrice: 70, expectedSell: 99, targetPrice: 95, source: "set" });
  db.prepare(
    `INSERT INTO order_seen (order_id, item_id, user_id, ingame_name, type, platinum, variant,
                             created_at, updated_at, first_seen, last_seen, sightings, top_rank,
                             sweeps_at_best, quantity, user_status)
     VALUES ('bid1', 'rhino', 'b', 'Buyer', 'buy', 97, '', ?, ?, ?, ?, 1, 0, 0, 1, 'ingame')`,
  ).run(nowIso, nowIso, nowIso, nowIso);

  const t = listTrades(db).find((x) => x.id === id)!;
  assert.equal(t.targetPrice, 95);
  assert.deepEqual(t.exits.map((s) => s.kind), ["target_bid"]);
  assert.equal(t.exits[0]!.buyer?.ingameName, "Buyer");

  const positions = openPositions(db);
  assert.equal(unsentSignals(db, evaluatePositions(db, positions)).length, 1);
  assert.equal(
    unsentSignals(db, evaluatePositions(db, positions)).length,
    0,
    "not repeated every five minutes",
  );

  // A better bid is news; so is the same bid against a new target.
  db.prepare("UPDATE order_seen SET platinum = 99 WHERE order_id = 'bid1'").run();
  assert.equal(unsentSignals(db, evaluatePositions(db, positions)).length, 1);
  setTradeTarget(db, id, 98);
  assert.equal(unsentSignals(db, evaluatePositions(db, openPositions(db))).length, 1);
  db.close();
});

test("the items you hold are refreshed with the watchlist, so their exits read a fresh book", () => {
  const db = setsDb([{ id: "rhino", ask: 100, traded: 100, parts: [{ id: "chassis", qty: 1, ask: 60 }] }]);
  assert.deepEqual(watchedItems(db), []);
  const id = openTrade(db, { itemId: "rhino", buyPrice: 70 });
  assert.deepEqual(watchedItems(db).map((i) => i.id), ["rhino"]);
  closeTrade(db, id, { sellPrice: 90 });
  assert.deepEqual(watchedItems(db), [], "and stop being refreshed once sold");
  db.close();
});

// ── price history ───────────────────────────────────────────────────────────

test("price history returns the item's daily series and which way it is moving", () => {
  const db = setsDb([{ id: "rhino", ask: 100, traded: 90, parts: [{ id: "chassis", qty: 1, ask: 60 }] }]);
  db.prepare("UPDATE stat_summary SET median_30d = 100 WHERE item_id = 'rhino'").run();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const ins = db.prepare(
    "INSERT INTO stat_daily (item_id, day, variant, volume, median, min_price, max_price) VALUES ('rhino', ?, '', ?, ?, ?, ?)",
  );
  ins.run(day(3), 12, 92, 80, 105);
  ins.run(day(1), 9, 88, 85, 95);
  ins.run(day(200), 5, 150, 140, 160); // outside the window

  const h = priceHistory(db, "rhino")!;
  assert.deepEqual(h.days.map((d) => d.median), [92, 88], "oldest first, inside the window only");
  assert.equal(h.trend, -0.1, "90p this week against 100p over the month");
  assert.equal(priceHistory(db, "nope"), null);
  db.close();
});
