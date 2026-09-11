import type { Db } from "./index";
import type { TopOrders, WfmItemDetail, WfmItemSummary, WfmOrder } from "../wfm/types";
import { variantKey } from "../wfm/types";

/**
 * Writes are grouped into transactions: better-sqlite3 is synchronous, so a
 * 3,840-row sweep committed row-by-row is dominated by fsync.
 */

export function upsertCatalog(db: Db, items: WfmItemSummary[]): number {
  const stmt = db.prepare(
    `INSERT INTO item (id, slug, name, tags)
     VALUES (@id, @slug, @name, @tags)
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug,
       name = excluded.name,
       tags = excluded.tags`,
  );
  const run = db.transaction((rows: WfmItemSummary[]) => {
    for (const item of rows) {
      stmt.run({
        id: item.id,
        slug: item.slug,
        name: item.i18n["en"]?.name ?? item.slug,
        tags: JSON.stringify(item.tags),
      });
    }
  });
  run(items);
  return items.length;
}

/** Detail columns from /v2/item/{slug}. */
export function saveItemDetail(db: Db, detail: WfmItemDetail): void {
  db.prepare(
    `UPDATE item SET
       set_root = @set_root,
       quantity_in_set = @quantity_in_set,
       ducats = @ducats,
       req_mastery_rank = @req_mastery_rank,
       tradable = @tradable,
       detail_fetched_at = @now
     WHERE id = @id`,
  ).run({
    id: detail.id,
    set_root: detail.setRoot ? 1 : 0,
    quantity_in_set: detail.quantityInSet ?? null,
    ducats: detail.ducats ?? null,
    req_mastery_rank: detail.reqMasteryRank ?? null,
    tradable: detail.tradable ? 1 : 0,
    now: new Date().toISOString(),
  });
}

/**
 * Replace a set's component edges.
 *
 * `setParts` includes the set's own id — keeping it would make the set a
 * component of itself and inflate its computed cost.
 */
export function saveSetParts(
  db: Db,
  setId: string,
  parts: Array<{ partId: string; qty: number }>,
): void {
  const del = db.prepare("DELETE FROM item_part WHERE set_id = ?");
  const ins = db.prepare(
    "INSERT INTO item_part (set_id, part_id, qty) VALUES (?, ?, ?) " +
      "ON CONFLICT(set_id, part_id) DO UPDATE SET qty = excluded.qty",
  );
  db.transaction(() => {
    del.run(setId);
    for (const p of parts) {
      if (p.partId === setId) continue;
      ins.run(setId, p.partId, p.qty);
    }
  })();
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const hoursSince = (iso: string, now: number): number => (now - Date.parse(iso)) / 3_600_000;

export interface SnapshotRow {
  itemId: string;
  /** '' for plain items; 'r10', 'radiant', etc. for variant markets. */
  variant: string;
  lowSell: number | null;
  highBuy: number | null;
  sellP50: number | null;
  buyP50: number | null;
  sellCount: number;
  buyCount: number;
  newestSellAgeH: number | null;
}

/**
 * Reduce a top-of-book response to the numbers ranking needs.
 *
 * `low_sell` is the buy target; `sell_p50_top` is the fair value, because one
 * ghost order at the head of the book must not set the price.
 */
export function summariseTop(
  itemId: string,
  top: TopOrders,
  now = Date.now(),
  variant = "",
): SnapshotRow {
  const sells = top.sell.map((o) => o.platinum);
  const buys = top.buy.map((o) => o.platinum);
  const newest = top.sell.reduce<number | null>((best, o) => {
    const age = hoursSince(o.updatedAt, now);
    return best === null || age < best ? age : best;
  }, null);

  return {
    itemId,
    variant,
    lowSell: sells.length ? Math.min(...sells) : null,
    highBuy: buys.length ? Math.max(...buys) : null,
    sellP50: median(sells),
    buyP50: median(buys),
    sellCount: sells.length,
    buyCount: buys.length,
    newestSellAgeH: newest === null ? null : Number(newest.toFixed(2)),
  };
}

/**
 * One summary per variant present on the book.
 *
 * /top returns the best five per side sorted by price, and for a ranked mod
 * those five sells are typically rank 0 while the five buys are rank 10. Blending
 * them prices a good that does not exist. Splitting means some variants end up
 * one-sided, which is the honest answer: there is no spread between different
 * goods.
 */
export function summariseByVariant(
  itemId: string,
  top: TopOrders,
  now = Date.now(),
): SnapshotRow[] {
  const groups = new Map<string, TopOrders>();
  const bucket = (key: string): TopOrders => {
    let g = groups.get(key);
    if (!g) {
      g = { sell: [], buy: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const o of top.sell) bucket(variantKey(o)).sell.push(o);
  for (const o of top.buy) bucket(variantKey(o)).buy.push(o);

  // An item with no orders at all still gets one empty row. Grouping alone
  // would emit nothing, losing the difference between "we looked and the book
  // was empty" and "we never looked" — which a resumed sweep needs, or it
  // re-fetches every dead item every time.
  if (groups.size === 0) return [summariseTop(itemId, top, now, "")];

  return [...groups].map(([variant, orders]) => summariseTop(itemId, orders, now, variant));
}

export function insertSnapshots(
  db: Db,
  sweepId: number,
  rows: SnapshotRow[],
  takenAt = new Date().toISOString(),
): void {
  const stmt = db.prepare(
    `INSERT INTO snapshot
       (item_id, sweep_id, variant, taken_at, low_sell, high_buy, sell_p50_top,
        buy_p50_top, sell_count, buy_count, newest_sell_age_h)
     VALUES (@itemId, @sweepId, @variant, @takenAt, @lowSell, @highBuy, @sellP50,
             @buyP50, @sellCount, @buyCount, @newestSellAgeH)
     ON CONFLICT(item_id, sweep_id, variant) DO NOTHING`,
  );
  db.transaction((batch: SnapshotRow[]) => {
    for (const r of batch) stmt.run({ ...r, sweepId, takenAt });
  })(rows);
}

/**
 * Record every order observed, with its rank on the book.
 *
 * `sweeps_at_best` is the ghost signal — the cheapest order on the book that
 * nobody buys — and it only means anything if it counts SWEEPS, spaced hours
 * apart. It used to advance on every read of any kind:
 *
 *   - the 5-minute watchlist refresh advanced it 12 times an hour, so a fresh
 *     order became "ghost ×12" in the time it took to list it;
 *   - the live feed recorded every new order at rank 0 regardless of where it
 *     actually sat, so one feed sighting plus one sweep made "ghost ×2".
 *
 * So only a sweep advances it. Other reads may still END a streak when they see
 * the order undercut (rank > 0), because that is real evidence — but they never
 * extend one. `rank` is null when position is unknown, as it is for the feed.
 */
export interface RecordOptions {
  /** True only for a sweep. Watchlist refreshes and the live feed pass false. */
  countsAsSweep?: boolean;
  seenAt?: string;
}

export function recordOrders(
  db: Db,
  orders: Array<{ order: WfmOrder; rank: number | null }>,
  opts: RecordOptions | string = {},
): void {
  // Accepts the old positional seenAt too, so existing callers keep working.
  const o = typeof opts === "string" ? { seenAt: opts } : opts;
  const countsAsSweep = o.countsAsSweep ?? true;
  const seenAt = o.seenAt ?? new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO order_seen
       (order_id, item_id, user_id, ingame_name, type, platinum, variant,
        created_at, updated_at, first_seen, last_seen, sightings,
        top_rank, sweeps_at_best, left_top_at)
     VALUES (@order_id, @item_id, @user_id, @ingame_name, @type, @platinum, @variant,
             @created_at, @updated_at, @seen, @seen, 1,
             @rank, @at_best, NULL)
     ON CONFLICT(order_id) DO UPDATE SET
       platinum       = excluded.platinum,
       updated_at     = excluded.updated_at,
       ingame_name    = excluded.ingame_name,
       -- Must be refreshed, not just inserted: rows first seen before variants
       -- were understood carry an empty key, and without this they keep it
       -- forever — leaving the real asks invisible to any variant-scoped query.
       variant        = excluded.variant,
       last_seen      = excluded.last_seen,
       sightings      = order_seen.sightings + 1,
       -- An unknown rank (the feed) must not overwrite a known one.
       top_rank       = COALESCE(excluded.top_rank, order_seen.top_rank),
       sweeps_at_best = CASE
         WHEN @counts = 1 AND excluded.top_rank = 0 THEN order_seen.sweeps_at_best + 1
         WHEN @counts = 1                          THEN 0
         -- Not a sweep: never extend a streak, but end it on evidence of undercut.
         WHEN excluded.top_rank > 0                THEN 0
         ELSE order_seen.sweeps_at_best
       END,
       left_top_at    = NULL`,
  );
  db.transaction((batch: Array<{ order: WfmOrder; rank: number | null }>) => {
    for (const { order, rank } of batch) {
      stmt.run({
        order_id: order.id,
        item_id: order.itemId,
        user_id: order.user.id,
        ingame_name: order.user.ingameName,
        type: order.type,
        platinum: order.platinum,
        variant: variantKey(order),
        created_at: order.createdAt,
        updated_at: order.updatedAt,
        seen: seenAt,
        rank,
        at_best: countsAsSweep && rank === 0 ? 1 : 0,
        counts: countsAsSweep ? 1 : 0,
      });
    }
  })(orders);
}

/**
 * Mark orders that were on an item's top-of-book but no longer are.
 * See the schema note: this means "left the top five", not "sold".
 */
export function markLeftTop(
  db: Db,
  itemId: string,
  stillPresent: string[],
  at = new Date().toISOString(),
): void {
  const placeholders = stillPresent.map(() => "?").join(",");
  const sql =
    "UPDATE order_seen SET left_top_at = ?, sweeps_at_best = 0 " +
    "WHERE item_id = ? AND left_top_at IS NULL" +
    (stillPresent.length ? ` AND order_id NOT IN (${placeholders})` : "");
  db.prepare(sql).run(at, itemId, ...stillPresent);
}
