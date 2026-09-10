import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR } from "../wfm/config";
import { migrate } from "./migrate";

export type Db = Database.Database;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export const DEFAULT_DB_PATH = join(CACHE_DIR, "frametax.db");

/** Open (creating if needed) and bring the schema up to date. */
export function openDb(path: string = DEFAULT_DB_PATH): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The daemon writes from several jobs. Without this, a sweep flushing a batch
  // while the watcher records orders throws SQLITE_BUSY instead of waiting.
  db.pragma("busy_timeout = 5000");
  // Baseline creates anything missing; migrations alter what already exists.
  // Both run every open and are idempotent.
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db);
  return db;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function startSweep(db: Db, kind: "top" | "detail" | "stats"): number {
  const info = db
    .prepare("INSERT INTO sweep (kind, started_at) VALUES (?, ?)")
    .run(kind, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishSweep(db: Db, id: number, ok: number, failed: number): void {
  db.prepare(
    "UPDATE sweep SET finished_at = ?, items_ok = ?, items_failed = ? WHERE id = ?",
  ).run(new Date().toISOString(), ok, failed, id);
}
