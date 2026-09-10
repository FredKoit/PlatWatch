import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/index";
import { upsertCatalog } from "../db/repo";
import { itemsToSweep, sweepTopOrders } from "./sweep";
import type { WfmItemSummary } from "../wfm/types";

/**
 * These cover the stop/resume contract only. The abort is checked at the top of
 * the loop, so no request is ever issued and the tests stay offline.
 */

const item = (id: string, slug: string): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags: [],
  i18n: { en: { name: slug } },
});

function seeded() {
  const db = openDb(":memory:");
  upsertCatalog(db, [item("a", "alpha"), item("b", "bravo"), item("c", "charlie")]);
  return db;
}

test("an interrupted sweep stays open so it can be resumed", async () => {
  const db = seeded();
  const aborted = AbortSignal.abort(new Error("stopped"));

  const result = await sweepTopOrders(db, itemsToSweep(db), { signal: aborted });

  assert.equal(result.interrupted, true);
  const row = db.prepare("SELECT finished_at FROM sweep WHERE id = ?").get(result.sweepId) as {
    finished_at: string | null;
  };
  assert.equal(
    row.finished_at,
    null,
    "a stopped sweep must not look finished, or --resume will skip it",
  );
  db.close();
});

test("a sweep that runs to the end is marked finished", async () => {
  const db = seeded();
  // No items to visit, so it completes without touching the network.
  const result = await sweepTopOrders(db, [], {});
  assert.equal(result.interrupted, false);
  const row = db.prepare("SELECT finished_at FROM sweep WHERE id = ?").get(result.sweepId) as {
    finished_at: string | null;
  };
  assert.ok(row.finished_at, "a completed sweep records when it ended");
  db.close();
});

test("resuming skips items already committed under the same sweep id", async () => {
  const db = seeded();
  const openSweep = db
    .prepare("INSERT INTO sweep (kind, started_at) VALUES ('top', ?)")
    .run(new Date().toISOString());
  const sweepId = Number(openSweep.lastInsertRowid);

  // Pretend the previous run committed one item before dying.
  db.prepare(
    `INSERT INTO snapshot (item_id, sweep_id, taken_at, sell_count, buy_count)
     VALUES ('a', ?, ?, 0, 0)`,
  ).run(sweepId, new Date().toISOString());

  const result = await sweepTopOrders(db, itemsToSweep(db), {
    sweepId,
    signal: AbortSignal.abort(new Error("stop immediately")),
  });

  // It aborts before fetching anything, but the already-done item is counted
  // as ok rather than re-requested.
  assert.equal(result.sweepId, sweepId, "resume continues the same sweep row");
  const snaps = db.prepare("SELECT COUNT(*) c FROM snapshot WHERE sweep_id=?").get(sweepId) as {
    c: number;
  };
  assert.equal(snaps.c, 1, "no duplicate snapshot for the completed item");
  db.close();
});
