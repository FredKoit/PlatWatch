import type { Db } from "./index";

/**
 * Schema migrations.
 *
 * schema.sql is the baseline for a fresh database, applied with
 * CREATE TABLE IF NOT EXISTS. That is enough to CREATE things but cannot
 * CHANGE them: adding a column to a table that already exists is a no-op, and
 * "just rebuild the database" is not an acceptable answer once real crawl
 * history is in there — order_seen.first_seen cannot be re-derived at any
 * price, because it records when *you* first saw an order.
 *
 * So every schema change after the baseline goes here as an idempotent step,
 * tracked by PRAGMA user_version.
 */

export interface Migration {
  version: number;
  name: string;
  up(db: Db): void;
}

/** Adding a column only when it is absent, so re-running is harmless. */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  // An absent table returns no columns. Nothing to alter — schema.sql will
  // create it with the column already present.
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** A migration must tolerate a database where the table does not exist yet. */
function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return row !== undefined;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "stat_summary.last_traded_day",
    up(db) {
      // Price history can simply stop. Without this, an item whose series ended
      // days ago is indistinguishable from one trading right now.
      addColumn(db, "stat_summary", "last_traded_day", "TEXT");
    },
  },
  {
    version: 2,
    name: "per-variant pricing",
    up(db) {
      // Orders carry rank / subtype / star counts, and those are different
      // goods at different prices. Pricing an item as one market compares a
      // rank-0 mod against a rank-10 buy order and invents enormous margins.
      addColumn(db, "snapshot", "variant", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "order_seen", "variant", "TEXT NOT NULL DEFAULT ''");
      // The uniqueness rule changes with it: one row per item per variant per
      // sweep, not one per item per sweep.
      db.exec("DROP INDEX IF EXISTS snapshot_item_sweep");
      db.exec(
        "CREATE UNIQUE INDEX snapshot_item_sweep ON snapshot(item_id, sweep_id, variant)",
      );
    },
  },
  {
    version: 3,
    name: "per-variant price history",
    up(db) {
      // Price history is split by rank / subtype at the source: archon_vitality
      // returns a rank-0 series (median 23p) and a rank-10 series (median 92p).
      // Keyed only by (item, day), the two silently overwrote each other.
      //
      // Changing a PRIMARY KEY means recreating the table in SQLite. That is
      // acceptable here and ONLY here because these two tables are a cache of
      // upstream data that can be refetched. Never do this to order_seen, whose
      // first_seen records an observation that exists nowhere else.
      db.exec("DROP TABLE IF EXISTS stat_daily");
      db.exec("DROP TABLE IF EXISTS stat_summary");
      db.exec(`
        CREATE TABLE stat_daily (
          item_id   TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
          day       TEXT NOT NULL,
          variant   TEXT NOT NULL DEFAULT '',
          volume    INTEGER NOT NULL,
          median    REAL,
          avg_price REAL,
          min_price REAL,
          max_price REAL,
          PRIMARY KEY (item_id, day, variant)
        );
        CREATE TABLE stat_summary (
          item_id         TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
          variant         TEXT NOT NULL DEFAULT '',
          fetched_at      TEXT NOT NULL,
          volume_48h      INTEGER NOT NULL,
          volume_7d       INTEGER NOT NULL,
          volume_30d      INTEGER NOT NULL,
          median_7d       REAL,
          median_30d      REAL,
          days_traded_30d INTEGER NOT NULL,
          last_traded_day TEXT,
          PRIMARY KEY (item_id, variant)
        );
      `);
    },
  },
  {
    version: 4,
    name: "alert.suspicious",
    up(db) {
      // An alert can be a genuine outlier rather than a mistake. Recording which
      // lets the acceptance gate tell a flagged anomaly apart from a modelling
      // error — the distinction the rank-0-vs-rank-10 bug taught us to keep.
      addColumn(db, "alert", "suspicious", "INTEGER NOT NULL DEFAULT 0");
      // Alerts recorded the item but not which variant's market they came from,
      // so an alert could not be traced back to the book that produced it.
      addColumn(db, "alert", "variant", "TEXT NOT NULL DEFAULT ''");

      // Backfill: rows written before the flag existed. Uses the observable
      // consequence (a profit dwarfing its own reference on a buy-side alert)
      // rather than re-deriving the median, because the variant those rows came
      // from was never recorded. Approximate, and only ever applied to history.
      if (tableExists(db, "alert")) {
        db.exec(`
          UPDATE alert SET suspicious = 1
           WHERE kind = 'overpriced_buy'
             AND suspicious = 0
             AND profit > reference * 3
        `);
      }
    },
  },
  {
    version: 5,
    name: "flag alerts priced off an inflated ask book",
    up(db) {
      // Sell-side alerts used to be judged against the median of standing ASKS,
      // which sellers can set to anything. An item asking 60p while it trades at
      // 14.5p produced "bargains" that were well above market. detect() now
      // takes the lower of the ask median and the traded median.
      //
      // Rows written before that are flagged rather than deleted: the alert was
      // really shown, and hiding it would misrepresent what the tool did.
      if (!tableExists(db, "alert") || !tableExists(db, "stat_summary")) return;
      db.exec(`
        UPDATE alert SET suspicious = 1
         WHERE kind = 'underpriced_sell'
           AND suspicious = 0
           AND EXISTS (
             SELECT 1 FROM stat_summary ss
              WHERE ss.item_id = alert.item_id
                AND ss.variant = alert.variant
                AND ss.median_7d IS NOT NULL
                AND alert.reference > ss.median_7d * 3
           )
      `);
    },
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function migrate(db: Db): MigrationResult {
  const [row] = db.pragma("user_version") as Array<{ user_version: number }>;
  const from = row?.user_version ?? 0;
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      migration.up(db);
      // pragma cannot be parameterised; version is an integer literal we own.
      db.pragma(`user_version = ${migration.version}`);
    })();
    applied.push(`${migration.version}:${migration.name}`);
  }

  const [after] = db.pragma("user_version") as Array<{ user_version: number }>;
  return { from, to: after?.user_version ?? from, applied };
}
