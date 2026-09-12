import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../db/index";
import {
  getChecklist,
  importChecklists,
  listChecklists,
  normaliseEntries,
  saveChecklist,
  setChecklistStatus,
} from "./checklists";

function seeded(): Db {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO item (id, slug, name, tags) VALUES ('set-1','alpha_prime_set','Alpha Prime Set','[]'), ('set-2','beta_prime_set','Beta Prime Set','[]')",
  ).run();
  return db;
}

test("checklist progress persists with its shopping list, and closes only on purpose", () => {
  const db = seeded();
  try {
    const raw = { a: true, b: "contacted", c: { status: "purchased", paid: 25 } };
    assert.deepEqual(normaliseEntries(raw), { a: { status: "purchased" }, b: { status: "contacted" }, c: { status: "purchased", paid: 25 } });
    const entries = normaliseEntries(raw)!;
    saveChecklist(db, "set-1", entries, { itemId: "set-1", parts: [] });

    const [saved] = listChecklists(db);
    assert.equal(saved!.item_slug, "alpha_prime_set");
    assert.deepEqual(saved!.row, { itemId: "set-1", parts: [] });

    saveChecklist(db, "set-1", { ...entries, b: { status: "purchased" } });
    assert.deepEqual(getChecklist(db, "set-1")!.row, { itemId: "set-1", parts: [] }, "a save without a row keeps the stored one");

    assert.equal(setChecklistStatus(db, "set-1", "assembled"), true);
    assert.equal(listChecklists(db).length, 0, "no longer waiting for attention");
    assert.equal(listChecklists(db, "assembled").length, 1);
    saveChecklist(db, "set-1", entries);
    assert.equal(getChecklist(db, "set-1")!.status, "active", "saving progress reopens it");
    assert.equal(saveChecklist(db, "nope", entries), null);
  } finally { db.close(); }
});

test("importing browser checklists fills gaps and never overwrites newer progress", () => {
  const db = seeded();
  try {
    saveChecklist(db, "set-1", { k: { status: "purchased" } });
    const imported = importChecklists(db, {
      "set-1": { k: "needed" },
      "set-2": { k: "purchased" },
      unknown: { k: "purchased" },
      broken: { k: "sort of" },
    });
    assert.equal(imported, 1);
    assert.equal(getChecklist(db, "set-1")!.entries["k"]!.status, "purchased");
    assert.equal(getChecklist(db, "set-2")!.entries["k"]!.status, "purchased");
  } finally { db.close(); }
});

test("malformed checklist entries are refused rather than stored", () => {
  assert.equal(normaliseEntries([]), null);
  assert.equal(normaliseEntries({ k: { status: "maybe" } }), null);
  assert.equal(normaliseEntries({ k: { status: "purchased", paid: -1 } }), null);
  assert.equal(normaliseEntries({ k: { status: "purchased", paid: 1.5 } }), null);
});
