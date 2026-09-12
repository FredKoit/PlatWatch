import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { competingAsk, watch } from "./watcher";
import type { WfmItemSummary, WfmOrder } from "../wfm/types";

/**
 * The sniper used to capture a sweep id at startup and keep it forever. Once
 * that sweep aged past maxBaselineAgeH (36h), detect() suppressed every alert —
 * silently. These tests drive watch() offline through an injected feed.
 */

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("rhino", "rhino_prime_set")]);
  // Liquid, recently traded. Only the sweep's age is under test.
  db.prepare(
    `INSERT INTO stat_summary (item_id, variant, fetched_at, volume_48h, volume_7d,
                               volume_30d, median_7d, median_30d, days_traded_30d,
                               last_traded_day, last_traded_at)
     VALUES ('rhino', '', ?, 100, 400, 1600, 64, 62, 30, NULL, ?)`,
  ).run(iso(0), iso(HOUR));
  return db;
}

/** A completed sweep whose rhino snapshot was taken `ageMs` ago. */
function addSweep(db: Db, id: number, ageMs: number) {
  db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (?, 'top', ?, ?)").run(
    id,
    iso(ageMs),
    iso(ageMs),
  );
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, low_sell, high_buy,
                           sell_p50_top, sell_count, buy_count, newest_sell_age_h)
     VALUES ('rhino', ?, '', ?, 60, 45, 66, 5, 5, 1)`,
  ).run(id, iso(ageMs));
}

/** A fresh, reachable listing well under the 64p the item trades at. */
const cheapListing = (id: string, platinum = 40): WfmOrder => ({
  id,
  type: "sell",
  platinum,
  quantity: 1,
  perTrade: 1,
  visible: true,
  createdAt: iso(0),
  updatedAt: iso(0),
  itemId: "rhino",
  user: {
    id: `u-${id}`,
    ingameName: `Seller-${id}`,
    slug: `seller-${id}`,
    reputation: 10,
    platform: "pc",
    crossplay: true,
    locale: "en",
    status: "ingame",
  },
});

/** Runs watch() for a scripted sequence of polls, then stops. */
async function run(
  db: Db,
  polls: Array<() => WfmOrder[]>,
  extra: Partial<Parameters<typeof watch>[1]> = {},
) {
  const controller = new AbortController();
  const alerts: string[] = [];
  const moves: number[] = [];
  let call = 0;

  const stats = await watch(db, {
    pollMs: 1,
    signal: controller.signal,
    fetchRecent: async () => {
      const step = polls[call++];
      if (!step) {
        controller.abort();
        return [];
      }
      return step();
    },
    onAlert: (a) => {
      alerts.push(a.orderId);
    },
    onBaselineChange: (id) => moves.push(id),
    ...extra,
  });
  return { stats, alerts, moves };
}

test("regression: a sniper stuck on an old sweep goes silent", async () => {
  const db = seeded();
  addSweep(db, 1, 40 * HOUR); // older than the 36h baseline limit
  addSweep(db, 2, 0); // fresh — but the old sniper never looked at it

  // Reproduces the old behaviour: sweep id captured once and never re-read.
  const { alerts } = await run(db, [() => [cheapListing("a")]], { baselineSweep: () => 1 });

  assert.deepEqual(alerts, [], "a genuine 24p find was suppressed by baseline age");
  db.close();
});

test("a sweep that completes after startup is picked up", async () => {
  const db = seeded();
  addSweep(db, 1, 40 * HOUR); // the only sweep when the sniper starts

  const { alerts, moves, stats } = await run(db, [
    // Poll 1: judged against the stale sweep, so suppressed — correctly.
    () => [cheapListing("a")],
    // Between polls, the daemon's next sweep finishes. "a" is still on sale at
    // 40p — suppressed alerts still join the book — so "b" has to beat it.
    () => {
      addSweep(db, 2, 0);
      return [cheapListing("b", 25)];
    },
  ]);

  assert.deepEqual(alerts, ["b"], "the new sweep's baseline must be used for the next order");
  assert.deepEqual(moves, [2], "and the move is reported, so it can never be silent");
  assert.equal(stats.baselineSweepId, 2);
  db.close();
});

test("with no sweep at all the sniper waits rather than inventing a baseline", async () => {
  const db = seeded();
  const { alerts, stats } = await run(db, [() => [cheapListing("a")]]);
  assert.deepEqual(alerts, []);
  assert.equal(stats.baselineSweepId, null);
  db.close();
});

test("the first sweep to appear becomes the baseline", async () => {
  const db = seeded();
  const { alerts, moves } = await run(db, [
    () => [cheapListing("a")], // nothing to judge against yet — but it joins the book
    () => {
      addSweep(db, 1, 0);
      return [cheapListing("b", 25)]; // under "a", which is still on sale at 40p
    },
  ]);
  assert.deepEqual(alerts, ["b"]);
  assert.deepEqual(moves, [1]);
  db.close();
});

test("a cheap listing is resold under the book it joined, not under itself", async () => {
  // The batch is folded into the live book before detection, which makes the
  // 40p listing the cheapest ask on its own book. Judged against that, nothing
  // would ever fire; judged against the 60p already listed, it resells at 59p.
  const db = seeded();
  addSweep(db, 1, 0);
  const seen: Array<{ reference: number; profit: number }> = [];
  await run(db, [() => [cheapListing("a")]], {
    onAlert: (a) => void seen.push({ reference: a.reference, profit: a.profit }),
  });
  assert.deepEqual(seen, [{ reference: 59, profit: 19 }]);
  db.close();
});

test("a cheaper listing arriving alongside caps the resale", async () => {
  // 40p alone is a 19p find. With a 45p listing posted in the same window, the
  // 40p buyer resells under 45p: 4p, below the floor. And the 45p listing is
  // no bargain at all beside a 40p one.
  const db = seeded();
  addSweep(db, 1, 0);
  const pricier = { ...cheapListing("b"), platinum: 45 };
  const { alerts } = await run(db, [() => [cheapListing("a"), pricier]]);
  assert.deepEqual(alerts, []);
  db.close();
});

test("the competing ask ignores the listing itself, other goods, and unreachable sellers", () => {
  const me = cheapListing("me");
  const offline = { ...cheapListing("off"), platinum: 10, user: { ...cheapListing("off").user, status: "offline" as const } };
  const otherItem = { ...cheapListing("x"), platinum: 11, itemId: "volt" };
  const otherRank = { ...cheapListing("r"), platinum: 12, rank: 10 };
  const bid = { ...cheapListing("bid"), platinum: 13, type: "buy" as const };
  const prior = { lowSell: 60 } as Parameters<typeof competingAsk>[1];
  assert.equal(competingAsk(me, prior, [me, offline, otherItem, otherRank, bid]), 60);
  assert.equal(competingAsk(me, undefined, [me]), null, "no book and no rival: nothing to undercut");
});

test("an unchanged sweep does not report a move every poll", async () => {
  const db = seeded();
  addSweep(db, 1, 0);
  const { moves } = await run(db, [
    () => [cheapListing("a")],
    () => [cheapListing("b")],
    () => [cheapListing("c")],
  ]);
  assert.deepEqual(moves, [], "the baseline was already current at startup");
  db.close();
});
