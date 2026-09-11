import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import { saveSetParts, upsertCatalog } from "../db/repo";
import { setRootsMissingParts } from "./details";
import type { WfmItemSummary } from "../wfm/types";

/**
 * The daemon refreshed the catalogue but never fetched part lists, so sets
 * from a new Prime Access could never be considered for set arbitrage. The
 * hourly job now fetches only sets still missing their parts.
 */

const item = (id: string, slug: string, tags: string[] = []): WfmItemSummary => ({
  id,
  slug,
  gameRef: `/Lotus/${slug}`,
  tags,
  i18n: { en: { name: slug } },
});

function seeded(): Db {
  const db = openDb(":memory:");
  upsertCatalog(db, [
    item("old", "rhino_prime_set", ["set", "prime"]),
    item("old-part", "rhino_prime_chassis"),
    item("new", "brand_new_prime_set", ["set", "prime"]),
    item("not-a-set", "some_mod", ["mod"]),
  ]);
  saveSetParts(db, "old", [{ partId: "old-part", qty: 1 }]);
  return db;
}

const slugs = (db: Db) => setRootsMissingParts(db).map((r) => r.slug);

test("a set that arrived with the catalogue but has no parts is picked up", () => {
  const db = seeded();
  assert.deepEqual(slugs(db), ["brand_new_prime_set"]);
  db.close();
});

test("a set that already has its parts costs no requests", () => {
  const db = seeded();
  saveSetParts(db, "new", [{ partId: "old-part", qty: 1 }]);
  assert.deepEqual(slugs(db), [], "on a normal day the hourly job does nothing");
  db.close();
});

test("a set fetched recently is not retried every hour", () => {
  const db = seeded();
  // Fetched, but it listed no parts — must not become a request every hour.
  db.prepare("UPDATE item SET detail_fetched_at = datetime('now') WHERE id = 'new'").run();
  assert.deepEqual(slugs(db), []);
  db.close();
});

test("a failed or empty fetch is retried once it is a day old", () => {
  const db = seeded();
  db.prepare("UPDATE item SET detail_fetched_at = datetime('now', '-25 hours') WHERE id = 'new'").run();
  assert.deepEqual(slugs(db), ["brand_new_prime_set"]);
  db.close();
});
