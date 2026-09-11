import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { watch } from "./watcher";
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
const cheapListing = (id: string): WfmOrder => ({
  id,
  type: "sell",
  platinum: 40,
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
    // Between polls, the daemon's next sweep finishes.
    () => {
      addSweep(db, 2, 0);
      return [cheapListing("b")];
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
    () => [cheapListing("a")], // nothing to judge against yet
    () => {
      addSweep(db, 1, 0);
      return [cheapListing("b")];
    },
  ]);
  assert.deepEqual(alerts, ["b"]);
  assert.deepEqual(moves, [1]);
  db.close();
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
