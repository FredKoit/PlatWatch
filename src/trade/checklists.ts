import type { Db } from "../db/index";

/**
 * Set purchase checklists, in SQLite.
 *
 * They used to live in one browser's localStorage: clearing it, switching
 * browsers or restoring a backup lost the record of parts already paid for.
 * A checklist stays active — and on the Today queue — until it is marked
 * assembled or completed, or removed on purpose. A set that stops qualifying
 * as an opportunity half-way through buying it is exactly when you need it.
 */

export type ChecklistStatus = "active" | "assembled" | "completed" | "removed";
export const CHECKLIST_STATUSES: ChecklistStatus[] = ["active", "assembled", "completed", "removed"];
const ENTRY_STATUSES = ["needed", "contacted", "purchased", "unavailable"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export interface ChecklistEntry {
  status: EntryStatus;
  /** Actual platinum paid for the whole purchase. */
  paid?: number;
}

export interface SetChecklist {
  setItemId: string;
  item_slug: string;
  name: string;
  status: ChecklistStatus;
  entries: Record<string, ChecklistEntry>;
  /** The shopping list as last seen; replaced by a fresh one when the set is still ranked. */
  row: unknown;
  createdAt: string;
  updatedAt: string;
}

const MAX_ENTRIES = 300;
const MAX_ROW_BYTES = 200_000;

/**
 * Validate entries from the page. Accepts the old localStorage shapes too —
 * `true` and a bare status string both meant a status. Null when invalid.
 */
export function normaliseEntries(value: unknown): Record<string, ChecklistEntry> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const pairs = Object.entries(value as Record<string, unknown>);
  if (pairs.length > MAX_ENTRIES) return null;
  const out: Record<string, ChecklistEntry> = {};
  for (const [key, raw] of pairs) {
    if (key.length === 0 || key.length > 300) return null;
    const status = raw === true ? "purchased" : typeof raw === "string" ? raw : (raw as { status?: unknown } | null)?.status;
    if (!ENTRY_STATUSES.includes(status as EntryStatus)) return null;
    const paidRaw = typeof raw === "object" && raw !== null ? (raw as { paid?: unknown }).paid : undefined;
    const paid = paidRaw === undefined || paidRaw === null || paidRaw === "" ? undefined : Number(paidRaw);
    if (paid !== undefined && !(Number.isInteger(paid) && paid >= 0 && paid <= 1_000_000)) return null;
    out[key] = { status: status as EntryStatus, ...(paid !== undefined ? { paid } : {}) };
  }
  return out;
}

interface Stored {
  set_item_id: string;
  slug: string;
  name: string;
  status: ChecklistStatus;
  entries_json: string;
  row_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT c.*, i.slug, i.name FROM set_checklist c JOIN item i ON i.id = c.set_item_id`;

function parse(row: Stored): SetChecklist {
  const json = (text: string | null, fallback: unknown) => {
    try { return text === null ? fallback : JSON.parse(text); } catch { return fallback; }
  };
  return {
    setItemId: row.set_item_id,
    item_slug: row.slug,
    name: row.name,
    status: row.status,
    entries: json(row.entries_json, {}) as Record<string, ChecklistEntry>,
    row: json(row.row_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChecklist(db: Db, setItemId: string): SetChecklist | null {
  const row = db.prepare(`${SELECT} WHERE c.set_item_id = ?`).get(setItemId) as Stored | undefined;
  return row ? parse(row) : null;
}

export function listChecklists(db: Db, status: ChecklistStatus = "active"): SetChecklist[] {
  return (db.prepare(`${SELECT} WHERE c.status = ? ORDER BY c.updated_at DESC`).all(status) as Stored[]).map(parse);
}

/**
 * Save progress. Saving reopens a checklist that had been closed — you are
 * clearly still buying — and keeps the stored shopping list when none is sent.
 * Null when the set is not a known item.
 */
export function saveChecklist(
  db: Db,
  setItemId: string,
  entries: Record<string, ChecklistEntry>,
  row?: unknown,
): SetChecklist | null {
  if (!db.prepare("SELECT 1 FROM item WHERE id = ?").get(setItemId)) return null;
  const rowJson = row === undefined ? undefined : JSON.stringify(row);
  const keepRow = rowJson === undefined || rowJson.length > MAX_ROW_BYTES;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO set_checklist (set_item_id, status, entries_json, row_json, created_at, updated_at)
     VALUES (@id, 'active', @entries, @row, @now, @now)
     ON CONFLICT(set_item_id) DO UPDATE SET
       status = 'active', entries_json = excluded.entries_json, updated_at = excluded.updated_at,
       row_json = CASE WHEN @keepRow THEN set_checklist.row_json ELSE excluded.row_json END`,
  ).run({ id: setItemId, entries: JSON.stringify(entries), row: keepRow ? null : rowJson, now, keepRow: keepRow ? 1 : 0 });
  return getChecklist(db, setItemId);
}

export function setChecklistStatus(db: Db, setItemId: string, status: ChecklistStatus): boolean {
  return db
    .prepare("UPDATE set_checklist SET status = ?, updated_at = ? WHERE set_item_id = ?")
    .run(status, new Date().toISOString(), setItemId).changes > 0;
}

/**
 * One-time move from localStorage. Only fills in sets the database has no
 * checklist for, so importing twice — or from a stale second browser — never
 * overwrites newer progress. Returns how many were imported.
 */
export function importChecklists(db: Db, legacy: Record<string, unknown>): number {
  let imported = 0;
  db.transaction(() => {
    for (const [setItemId, raw] of Object.entries(legacy)) {
      const entries = normaliseEntries(raw);
      if (!entries || Object.keys(entries).length === 0) continue;
      if (db.prepare("SELECT 1 FROM set_checklist WHERE set_item_id = ?").get(setItemId)) continue;
      if (saveChecklist(db, setItemId, entries)) imported++;
    }
  })();
  return imported;
}
