import type { Db } from "../db/index";
import { latestSweepId, setRows, spreadRows } from "../rank/query";
import {
  DEFAULT_POLICY,
  rank,
  scoreSet,
  scoreSpread,
  type Opportunity,
  type RankingPolicy,
  type SortBy,
} from "../rank/score";
import { whisperFor } from "../live/detect";

/**
 * Everything the UI reads. Kept separate from the HTTP layer so the queries can
 * be tested without a server.
 */

export interface Counterparty {
  userId: string;
  ingameName: string;
  platinum: number;
  /** Sightings and reply history, so you can prefer people who answer. */
  sent: number;
  replied: number;
  replyRate: number | null;
}

/** One component you must acquire to assemble a set. */
export interface PartOffer {
  itemId: string;
  name: string;
  qty: number;
  price: number | null;
  seller: Counterparty | null;
  whisper: string | null;
}

/**
 * How a row is actually executed.
 *
 * This matters because the two strategies need opposite actions, and conflating
 * them loses money. A spread is MARKET MAKING: you post a bid above the best
 * bid and an ask below the best ask, and wait for both. Whispering the cheapest
 * seller at their asking price and then selling below it is a guaranteed loss —
 * which is exactly what a single "copy whisper" button invited.
 *
 * Set arbitrage is the opposite: you take component asks, so whispering each
 * part's cheapest seller at their price IS the trade.
 */
export type PlayKind = "post" | "buy-parts";

export interface Row extends Opportunity {
  /** Whom you would actually message, and the message itself. */
  seller: Counterparty | null;
  buyer: Counterparty | null;
  playKind: PlayKind;
  /** For "post": the two orders to place, and wait for. */
  postBuyAt: number | null;
  postSellAt: number | null;
  /**
   * An active attempt at the buy leg — offering the cheapest seller the price
   * the model assumes, not their asking price. Often declined; that is the
   * strategy, not a fault.
   */
  lowballWhisper: string | null;
  /** For "buy-parts": every component, each at its own seller's ask. */
  parts: PartOffer[] | null;
  watched: boolean;
  /** Age of the price this row is built on. */
  priceAgeH: number | null;
  /**
   * Consecutive sweeps the cheapest ask has held its position without selling.
   * A high number is the ghost signal: nobody is buying it at that price, so
   * either the seller does not respond or the price is fiction.
   */
  ghostSweeps: number;
}

interface OrderRow {
  user_id: string;
  ingame_name: string;
  platinum: number;
  sweeps_at_best: number;
}

/**
 * Reply rates from your own whisper log.
 *
 * This is the signal no public tool can build: a seller who never answers is
 * worse than one asking 5p more, and only your own trade attempts reveal that.
 */
export function sellerStats(db: Db): Map<string, { sent: number; replied: number }> {
  const rows = db
    .prepare(
      `SELECT user_id,
              COUNT(*) AS sent,
              SUM(CASE WHEN replied = 1 THEN 1 ELSE 0 END) AS replied
         FROM whisper_log
        GROUP BY user_id`,
    )
    .all() as Array<{ user_id: string; sent: number; replied: number }>;
  return new Map(rows.map((r) => [r.user_id, { sent: r.sent, replied: r.replied }]));
}

function counterparty(
  order: OrderRow | undefined,
  stats: Map<string, { sent: number; replied: number }>,
): Counterparty | null {
  if (!order) return null;
  const s = stats.get(order.user_id);
  return {
    userId: order.user_id,
    ingameName: order.ingame_name,
    platinum: order.platinum,
    sent: s?.sent ?? 0,
    replied: s?.replied ?? 0,
    replyRate: s && s.sent > 0 ? s.replied / s.sent : null,
  };
}

/** Best order per side still on the book — whom a whisper would go to. */
function bestOrderStmt(db: Db) {
  return db.prepare(
    `SELECT user_id, ingame_name, platinum, sweeps_at_best
       FROM order_seen
      WHERE item_id = @itemId AND variant = @variant AND type = @type
        AND left_top_at IS NULL
      ORDER BY CASE WHEN @type = 'sell' THEN platinum END ASC,
               CASE WHEN @type = 'buy'  THEN platinum END DESC
      LIMIT 1`,
  );
}

/**
 * A set component's cheapest live seller, and the whisper that takes their ask.
 * For set arbitrage paying the ask IS the trade, unlike a spread.
 */
function componentOffer(
  bestOrder: ReturnType<typeof bestOrderStmt>,
  stats: Map<string, { sent: number; replied: number }>,
  part: { itemId: string; name: string },
): { seller: Counterparty | null; whisper: string | null } {
  const order = bestOrder.get({ itemId: part.itemId, variant: "", type: "sell" }) as
    | OrderRow
    | undefined;
  const seller = counterparty(order, stats);
  return {
    seller,
    whisper: seller ? whisperFor(seller.ingameName, part.name, seller.platinum, "buy") : null,
  };
}

export interface OpportunityQuery {
  kind?: "spread" | "set";
  limit?: number;
  watchedOnly?: boolean;
  /** Most platinum to tie up in one trade. */
  maxBuyAt?: number | null;
  sortBy?: SortBy;
}

export function opportunities(db: Db, q: OpportunityQuery = {}): Row[] {
  const sweepId = latestSweepId(db);
  if (sweepId === null) return [];

  const policy: RankingPolicy = {
    ...DEFAULT_POLICY,
    ...(q.maxBuyAt !== undefined ? { maxBuyAt: q.maxBuyAt } : {}),
  };

  const all: Array<Opportunity | null> = [];
  if (q.kind !== "set") all.push(...spreadRows(db, sweepId).map((r) => scoreSpread(r, policy)));
  if (q.kind !== "spread") all.push(...setRows(db, sweepId).map((s) => scoreSet(s, policy)));

  const ranked = rank(all, q.sortBy ?? "score");
  const stats = sellerStats(db);

  const watched = new Set(
    (
      db.prepare("SELECT item_id, variant FROM watchlist").all() as Array<{
        item_id: string;
        variant: string;
      }>
    ).map((w) => `${w.item_id}|${w.variant}`),
  );

  const bestOrder = bestOrderStmt(db);

  const partsOf = db.prepare(
    `SELECT p.id AS itemId, p.name AS name, ip.qty AS qty, ps.low_sell AS price
       FROM item_part ip
       JOIN item p ON p.id = ip.part_id
       LEFT JOIN snapshot ps ON ps.item_id = ip.part_id AND ps.sweep_id = @sweep
                            AND ps.variant = ''
      WHERE ip.set_id = @setId
      ORDER BY p.name`,
  );

  const takenAt = db
    .prepare("SELECT taken_at FROM snapshot WHERE sweep_id = ? LIMIT 1")
    .get(sweepId) as { taken_at: string } | undefined;
  const priceAgeH = takenAt
    ? (Date.now() - Date.parse(takenAt.taken_at)) / 3_600_000
    : null;

  const rows = ranked.slice(0, q.limit ?? 100).map<Row>((o) => {
    const key = { itemId: o.itemId, variant: o.variant };
    const sellOrder = bestOrder.get({ ...key, type: "sell" }) as OrderRow | undefined;
    const seller = counterparty(sellOrder, stats);
    const buyer = counterparty(bestOrder.get({ ...key, type: "buy" }) as OrderRow, stats);

    // Set arbitrage acquires components, so a whisper about the assembled set
    // is meaningless — the seller of the set is not who you trade with.
    const parts =
      o.kind === "set"
        ? (partsOf.all({ sweep: sweepId, setId: o.itemId }) as Array<{
            itemId: string;
            name: string;
            qty: number;
            price: number | null;
          }>).map<PartOffer>((p) => ({ ...p, ...componentOffer(bestOrder, stats, p) }))
        : null;

    return {
      ghostSweeps: sellOrder?.sweeps_at_best ?? 0,
      ...o,
      seller,
      buyer,
      playKind: o.kind === "set" ? "buy-parts" : "post",
      postBuyAt: o.kind === "spread" ? o.buyAt : null,
      postSellAt: o.kind === "spread" ? o.sellAt : null,
      // Offers the model's buy price, NOT the seller's ask. Paying the ask and
      // then undercutting it is how the old button lost money.
      lowballWhisper:
        o.kind === "spread" && seller ? whisperFor(seller.ingameName, o.name, o.buyAt, "buy") : null,
      parts,
      watched: watched.has(`${o.itemId}|${o.variant}`),
      priceAgeH: priceAgeH === null ? null : Number(priceAgeH.toFixed(2)),
    };
  });

  return q.watchedOnly ? rows.filter((r) => r.watched) : rows;
}

/** One line of a set's shopping list. */
export interface SetPart {
  itemId: string;
  name: string;
  qty: number;
  /** Cheapest ask per unit — the exact price the set's cost is built from. */
  each: number | null;
  /** `each × qty`. The lines always sum to the set's `buyAt`. */
  subtotal: number | null;
  volume48h: number | null;
  seller: Counterparty | null;
  whisper: string | null;
}

/** A set costed as its parts, against what the assembled set sells for. */
export interface SetRow extends Opportunity {
  /** Cheapest ask for the assembled set — the one you undercut. */
  setAsk: number;
  /** 7-day median of completed set trades, which caps `sellAt`. */
  tradedAt: number | null;
  /**
   * Set when the asks sit above where sets trade, so `sellAt` is the traded
   * price rather than an undercut of the book — the edge a sum against the
   * ask would promise is not there.
   */
  cappedByTrades: boolean;
  /** Parts with no ask, which make `buyAt` and `margin` unknown rather than zero. */
  unpriced: number;
  parts: SetPart[];
}

export type SetSort =
  /** Platinum per set assembled — the most profit from one trip. */
  | "margin"
  /** Margin as a fraction of the parts bill. */
  | "return"
  /** Platinum per 48h, bounded by the slowest component. */
  | "score";

export interface SetQuery {
  sortBy?: SetSort;
  /** Also list what the policy holds back, with its reasons, after the tradable rows. */
  includeHeldBack?: boolean;
  maxBuyAt?: number | null;
  limit?: number;
}

export interface SetComparison {
  rows: SetRow[];
  tradable: number;
  /** Sets with a price for every part, so an edge could be computed at all. */
  priced: number;
}

/**
 * Every set, costed as its components and compared against the set.
 *
 * The same scoring as the set rows in `opportunities`, laid out so the
 * comparison itself is visible: each part's price × quantity, their sum, and
 * what the set sells for. Held-back sets are listed on request because the
 * reason is often worth seeing — a fat edge on a set nobody buys is a trap,
 * and silently filtering it hides that.
 */
export function setArbitrage(db: Db, q: SetQuery = {}): SetComparison {
  const sweepId = latestSweepId(db);
  if (sweepId === null) return { rows: [], tradable: 0, priced: 0 };

  const policy: RankingPolicy = {
    ...DEFAULT_POLICY,
    ...(q.maxBuyAt !== undefined ? { maxBuyAt: q.maxBuyAt } : {}),
  };

  const scored = setRows(db, sweepId).flatMap((input) => {
    const o = scoreSet(input, policy);
    return o ? [{ input, o }] : [];
  });

  const isTradable = (o: Opportunity) => o.rejects.length === 0 && o.margin > 0;
  const isPriced = ({ input }: (typeof scored)[number]) =>
    input.parts.every((p) => p.lowSell !== null);
  const key = (o: Opportunity) =>
    q.sortBy === "return" ? o.marginPct : q.sortBy === "score" ? o.score : o.margin;

  // Tradable first, then held back, then unpriced — an unknown edge sorted as
  // zero would otherwise land between real gains and real losses.
  const tier = (s: (typeof scored)[number]) => (isTradable(s.o) ? 0 : isPriced(s) ? 1 : 2);
  const listed = scored
    .filter((s) => q.includeHeldBack || isTradable(s.o))
    .sort((a, b) => tier(a) - tier(b) || key(b.o) - key(a.o));

  const stats = sellerStats(db);
  const bestOrder = bestOrderStmt(db);

  const rows = listed.slice(0, q.limit ?? 300).map<SetRow>(({ input, o }) => ({
    ...o,
    setAsk: input.set.lowSell!,
    tradedAt: input.set.median7d ?? null,
    cappedByTrades: o.sellAt < input.set.lowSell! - policy.undercut,
    unpriced: input.parts.filter((p) => p.lowSell === null).length,
    parts: [...input.parts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map<SetPart>((p) => ({
        itemId: p.itemId,
        name: p.name,
        qty: p.qty,
        each: p.lowSell,
        subtotal: p.lowSell === null ? null : p.lowSell * p.qty,
        volume48h: p.volume48h,
        ...componentOffer(bestOrder, stats, p),
      })),
  }));

  return {
    rows,
    tradable: scored.filter((s) => isTradable(s.o)).length,
    priced: scored.filter(isPriced).length,
  };
}

export function recentAlerts(db: Db, limit = 50) {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, i.slug AS item_slug
         FROM alert a JOIN item i ON i.id = a.item_id
        ORDER BY a.fired_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function status(db: Db) {
  const sweep = db
    .prepare(
      "SELECT id, started_at, finished_at, items_ok FROM sweep WHERE kind='top' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: number; finished_at: string; items_ok: number } | undefined;

  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

  return {
    sweepId: sweep?.id ?? null,
    sweptAt: sweep?.finished_at ?? null,
    sweepAgeH: sweep ? Number(((Date.now() - Date.parse(sweep.finished_at)) / 3_600_000).toFixed(1)) : null,
    items: count("SELECT COUNT(*) c FROM item"),
    markets: sweep
      ? (db.prepare("SELECT COUNT(*) c FROM snapshot WHERE sweep_id=?").get(sweep.id) as { c: number }).c
      : 0,
    ordersTracked: count("SELECT COUNT(*) c FROM order_seen"),
    alerts: count("SELECT COUNT(*) c FROM alert"),
    whispers: count("SELECT COUNT(*) c FROM whisper_log"),
    watched: count("SELECT COUNT(*) c FROM watchlist"),
  };
}

export function logWhisper(
  db: Db,
  w: { itemId: string; userId: string; ingameName: string; platinum: number; orderId?: string; note?: string },
): number {
  const info = db
    .prepare(
      `INSERT INTO whisper_log (order_id, item_id, user_id, ingame_name, platinum, sent_at, note)
       VALUES (@orderId, @itemId, @userId, @ingameName, @platinum, @sentAt, @note)`,
    )
    .run({
      orderId: w.orderId ?? null,
      itemId: w.itemId,
      userId: w.userId,
      ingameName: w.ingameName,
      platinum: w.platinum,
      sentAt: new Date().toISOString(),
      note: w.note ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function resolveWhisper(
  db: Db,
  id: number,
  outcome: { replied?: boolean; traded?: boolean },
): void {
  db.prepare(
    `UPDATE whisper_log
        SET replied = COALESCE(@replied, replied),
            traded  = COALESCE(@traded, traded)
      WHERE id = @id`,
  ).run({
    id,
    replied: outcome.replied === undefined ? null : outcome.replied ? 1 : 0,
    traded: outcome.traded === undefined ? null : outcome.traded ? 1 : 0,
  });
}

export function pendingWhispers(db: Db, limit = 30) {
  return db
    .prepare(
      `SELECT w.*, i.name AS item_name
         FROM whisper_log w JOIN item i ON i.id = w.item_id
        ORDER BY w.sent_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function setWatched(db: Db, itemId: string, variant: string, on: boolean): void {
  if (on) {
    db.prepare(
      "INSERT INTO watchlist (item_id, variant, added_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(item_id, variant) DO NOTHING",
    ).run(itemId, variant, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM watchlist WHERE item_id = ? AND variant = ?").run(itemId, variant);
  }
}

/** Items on the watchlist, for the frequent re-poll loop. */
export function watchedItems(db: Db): Array<{ id: string; slug: string; name: string; tags: string }> {
  return db
    .prepare(
      `SELECT DISTINCT i.id, i.slug, i.name, i.tags
         FROM watchlist w JOIN item i ON i.id = w.item_id
        ORDER BY i.slug`,
    )
    .all() as Array<{ id: string; slug: string; name: string; tags: string }>;
}
