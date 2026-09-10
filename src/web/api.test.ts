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

  const stat = (id: string) =>
    db
      .prepare(
        `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d,
                                   volume_30d, median_7d, median_30d, days_traded_30d, last_traded_day)
         VALUES (?, '', ?, 50, 200, 800, 30, 30, 30, ?)`,
      )
      .run(id, nowIso, today);
  stat("kamas");
  stat("blade");
  stat("handle");

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
