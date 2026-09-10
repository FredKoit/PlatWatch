import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, MIGRATIONS } from "./migrate";
import type { Db } from "./index";

/**
 * The point of these: a schema change must never require rebuilding a database
 * that holds crawl history. order_seen.first_seen records when *you* first saw
 * an order and cannot be re-fetched at any price.
 */

/** A database as it looked before `last_traded_day` existed. */
function legacyDb(): Db {
  const db = new Database(":memory:") as Db;
  db.exec(`
    CREATE TABLE stat_summary (
      item_id         TEXT PRIMARY KEY,
      fetched_at      TEXT NOT NULL,
      volume_48h      INTEGER NOT NULL,
      volume_7d       INTEGER NOT NULL,
      volume_30d      INTEGER NOT NULL,
      median_7d       REAL,
      median_30d      REAL,
      days_traded_30d INTEGER NOT NULL
    );
    CREATE TABLE order_seen (
      order_id   TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE snapshot (
      id       INTEGER PRIMARY KEY,
      item_id  TEXT NOT NULL,
      sweep_id INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX snapshot_item_sweep ON snapshot(item_id, sweep_id);
  `);
  return db;
}

const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

test("observation history survives migration; caches may be rebuilt", () => {
  const db = legacyDb();
  db.prepare(
    `INSERT INTO stat_summary VALUES ('i1','2026-09-01T00:00:00Z',10,50,200,15.0,14.0,20)`,
  ).run();
  db.prepare(`INSERT INTO order_seen VALUES ('o1','2026-08-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO snapshot (item_id, sweep_id) VALUES ('i1', 1)`).run();

  assert.ok(!columns(db, "stat_summary").includes("last_traded_day"), "precondition");

  const result = migrate(db);
  assert.equal(result.from, 0);
  assert.equal(result.to, MIGRATIONS.at(-1)!.version);

  // The invariant that matters: order_seen.first_seen records when YOU saw an
  // order. It exists nowhere upstream and must never be rebuilt.
  const kept = db.prepare("SELECT first_seen FROM order_seen WHERE order_id='o1'").get() as {
    first_seen: string;
  };
  assert.equal(kept.first_seen, "2026-08-01T00:00:00Z", "crawl history is never rebuilt");
  assert.ok(columns(db, "order_seen").includes("variant"), "and gains new columns in place");

  // snapshot is also altered in place rather than recreated.
  const snap = db.prepare("SELECT item_id, variant FROM snapshot WHERE item_id='i1'").get() as {
    item_id: string;
    variant: string;
  };
  assert.equal(snap.variant, "", "existing rows get the default variant");

  // stat_summary is a cache of upstream data, so migration 3 rebuilds it with a
  // composite key. Losing its contents is acceptable precisely because a refetch
  // restores them.
  assert.ok(columns(db, "stat_summary").includes("variant"));
  const cached = db.prepare("SELECT COUNT(*) c FROM stat_summary").get() as { c: number };
  assert.equal(cached.c, 0, "the cache is rebuilt, and refetching restores it");
});

test("migrating twice is a no-op", () => {
  const db = legacyDb();
  migrate(db);
  const second = migrate(db);
  assert.deepEqual(second.applied, [], "already-applied migrations must not re-run");
  assert.equal(second.from, second.to);
  db.close();
});

test("a database already carrying the column is left alone", () => {
  const db = legacyDb();
  db.exec("ALTER TABLE stat_summary ADD COLUMN last_traded_day TEXT");
  // user_version is still 0, so the step runs — and must tolerate that.
  assert.doesNotThrow(() => migrate(db));
  assert.equal(
    columns(db, "stat_summary").filter((c) => c === "last_traded_day").length,
    1,
    "no duplicate column",
  );
  db.close();
});
