import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, MIGRATIONS } from "./migrate";
import { openDb, type Db } from "./index";

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

test("history is classified by what each sweep actually covered", () => {
  // The real database: full sweeps at 94-100%, and an empty one from a crash.
  const db = openDb(":memory:");
  db.exec("PRAGMA user_version = 6"); // everything before sweep.scope
  const items = Array.from({ length: 100 }, (_, i) => `i${i}`);
  for (const id of items) {
    db.prepare("INSERT INTO item (id, slug, name, tags) VALUES (?, ?, ?, '[]')").run(id, id, id);
  }
  const sweep = (id: number, covered: number) => {
    db.prepare("INSERT INTO sweep (id, kind, started_at, finished_at) VALUES (?, 'top', 'x', 'x')").run(id);
    for (const itemId of items.slice(0, covered)) {
      db.prepare(
        `INSERT INTO snapshot (item_id, sweep_id, variant, taken_at, sell_count, buy_count)
         VALUES (?, ?, '', 'x', 0, 0)`,
      ).run(itemId, id);
    }
  };
  sweep(1, 100);
  sweep(2, 94); // a full sweep: some items legitimately have no book
  sweep(3, 0); // the empty one a crash left behind
  sweep(4, 3); // a --limit run

  // Force migration 7 to run against rows that all defaulted to 'full'.
  db.exec("UPDATE sweep SET scope = 'full'");
  db.exec("PRAGMA user_version = 6");
  migrate(db);

  const scopes = db.prepare("SELECT id, scope FROM sweep ORDER BY id").all() as Array<{
    id: number;
    scope: string;
  }>;
  assert.deepEqual(scopes, [
    { id: 1, scope: "full" },
    { id: 2, scope: "full" },
    { id: 3, scope: "partial" },
    { id: 4, scope: "partial" },
  ]);
  db.close();
});

test("order depth and seller status arrive as columns, leaving every observation in place", () => {
  // A v7 database: order_seen without quantity or status, trade without a target.
  const db = openDb(":memory:");
  db.exec(`
    DROP TABLE exit_alert;
    CREATE TABLE trade_v7 AS SELECT id, item_id, variant, quantity, buy_price, bought_at, bought_from,
      sell_price, sold_at, sold_to, expected_sell, expected_margin, source, note FROM trade;
    DROP TABLE trade; ALTER TABLE trade_v7 RENAME TO trade;
    CREATE TABLE order_v7 AS SELECT order_id, item_id, user_id, ingame_name, type, platinum, variant,
      created_at, updated_at, first_seen, last_seen, sightings, top_rank, sweeps_at_best, left_top_at
      FROM order_seen;
    DROP TABLE order_seen; ALTER TABLE order_v7 RENAME TO order_seen;
    PRAGMA user_version = 7;
  `);
  db.prepare(
    `INSERT INTO order_seen VALUES ('o1','i','u','who','sell',30,'','t','t','2026-08-01T00:00:00Z','t',4,0,2,NULL)`,
  ).run();

  const result = migrate(db);
  assert.deepEqual(result.applied, [
    "8:order depth, seller status, trade targets",
    "9:durable notification outbox",
    "10:alert outcome feedback",
    "11:trade audit and buy fill timing",
  ]);
  assert.ok(columns(db, "order_seen").includes("quantity"));
  assert.ok(columns(db, "order_seen").includes("user_status"));
  assert.ok(columns(db, "trade").includes("target_price"));
  assert.ok(columns(db, "trade").includes("buy_wait_h"));
  assert.ok(columns(db, "trade_audit").includes("before_json"));
  assert.ok(columns(db, "notification_outbox").includes("next_attempt_at"));

  const kept = db.prepare("SELECT first_seen, sightings, quantity FROM order_seen WHERE order_id='o1'").get() as {
    first_seen: string;
    sightings: number;
    quantity: number | null;
  };
  assert.equal(kept.first_seen, "2026-08-01T00:00:00Z", "crawl history is never rebuilt");
  assert.equal(kept.sightings, 4);
  assert.equal(kept.quantity, null, "unknown until the next sweep re-observes it");
  db.close();
});
