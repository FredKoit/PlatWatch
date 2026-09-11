import type { Db } from "../db/index";
import { saveItemDetail, saveSetParts } from "../db/repo";
import { getItem } from "../wfm/client";
import { WfmError } from "../wfm/errors";

export interface ItemRow {
  id: string;
  slug: string;
  name: string;
  tags: string;
}

/**
 * Tag vocabulary is inconsistent between items, so a category is matched with
 * a set of candidate tags rather than one name. See the note in wfm/catalog.ts.
 */
const SET_TAGS = new Set(["set"]);

export function findSetRoots(db: Db): ItemRow[] {
  const rows = db.prepare("SELECT id, slug, name, tags FROM item").all() as ItemRow[];
  return rows.filter((r) => {
    const tags = JSON.parse(r.tags) as string[];
    return tags.some((t) => SET_TAGS.has(t));
  });
}

export interface DetailProgress {
  (done: number, total: number, phase: "sets" | "parts"): void;
}

export interface DetailResult {
  sets: number;
  parts: number;
  failed: number;
  /** Parts needing more than one per set — the arbitrage trap, quantified. */
  multiQtyParts: number;
}

/**
 * Fetch detail for every set root and every component they reference.
 *
 * Costs roughly 1,200 requests (~7 min) rather than a full 3,840-item detail
 * pass, because only sets and their parts need `quantityInSet`. Cached by the
 * catalogue version, so it re-runs about monthly.
 */
/**
 * Set roots with no component edges yet — new sets from a Prime Access, or
 * ones whose earlier fetch failed.
 *
 * A set whose detail was fetched recently is skipped even if it still has no
 * edges, so one that genuinely lists no parts is retried daily rather than on
 * every run.
 */
export function setRootsMissingParts(db: Db, retryAfterHours = 24): ItemRow[] {
  const withEdges = new Set(
    (db.prepare("SELECT DISTINCT set_id FROM item_part").all() as Array<{ set_id: string }>).map(
      (r) => r.set_id,
    ),
  );
  const recent = new Set(
    (
      db
        .prepare(
          `SELECT id FROM item
            WHERE detail_fetched_at IS NOT NULL
              AND detail_fetched_at > datetime('now', ?)`,
        )
        .all(`-${retryAfterHours} hours`) as Array<{ id: string }>
    ).map((r) => r.id),
  );
  return findSetRoots(db).filter((r) => !withEdges.has(r.id) && !recent.has(r.id));
}

export async function ingestSetDetails(
  db: Db,
  onProgress?: DetailProgress,
  signal?: AbortSignal,
  opts: {
    /**
     * Only sets with no part edges. The daemon runs this hourly: on a normal
     * day it costs no requests at all, and when a Prime Access lands it picks
     * up the new sets within the hour instead of never.
     */
    onlyMissing?: boolean;
  } = {},
): Promise<DetailResult> {
  const setRoots = opts.onlyMissing ? setRootsMissingParts(db) : findSetRoots(db);
  const slugById = new Map(
    (db.prepare("SELECT id, slug FROM item").all() as Array<{ id: string; slug: string }>).map(
      (r) => [r.id, r.slug],
    ),
  );

  let failed = 0;
  const setParts = new Map<string, string[]>();

  for (const [i, root] of setRoots.entries()) {
    try {
      const detail = await getItem(root.slug, signal);
      saveItemDetail(db, detail);
      // setParts includes the set's own id; drop it here so it is never
      // counted as a component of itself.
      setParts.set(
        detail.id,
        (detail.setParts ?? []).filter((p) => p !== detail.id),
      );
    } catch (err) {
      failed++;
      if (!(err instanceof WfmError)) throw err;
    }
    onProgress?.(i + 1, setRoots.length, "sets");
  }

  const partIds = [...new Set([...setParts.values()].flat())];
  const qtyById = new Map<string, number>();

  for (const [i, partId] of partIds.entries()) {
    const slug = slugById.get(partId);
    if (!slug) {
      // Should not happen: parts resolve by id against the full catalogue.
      failed++;
      continue;
    }
    try {
      const detail = await getItem(slug, signal);
      saveItemDetail(db, detail);
      qtyById.set(partId, detail.quantityInSet ?? 1);
    } catch (err) {
      failed++;
      if (!(err instanceof WfmError)) throw err;
    }
    onProgress?.(i + 1, partIds.length, "parts");
  }

  let multiQtyParts = 0;
  for (const [setId, parts] of setParts) {
    const edges = parts.map((partId) => {
      const qty = qtyById.get(partId) ?? 1;
      if (qty > 1) multiQtyParts++;
      return { partId, qty };
    });
    saveSetParts(db, setId, edges);
  }

  return { sets: setParts.size, parts: partIds.length, failed, multiQtyParts };
}
