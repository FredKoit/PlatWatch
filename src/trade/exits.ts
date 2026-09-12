import type { Db } from "../db/index";
import { bookReader, unitsBelow, type BookOrder } from "../rank/depth";
import { formatDuration, sellTime } from "../rank/timing";
import { whisperFor } from "../live/detect";
import type { Notice } from "../live/notify";

/**
 * Exit alerts for what you already hold.
 *
 * The buy leg is quick — a whisper either lands or it doesn't. The sell leg is
 * where platinum sits waiting, and nothing watched it: a buyer could post a bid
 * at your price and leave again, or three sellers could list under you, and the
 * position just sat there. Three signals, evaluated against the same reachable
 * book the ranking reads:
 *
 *   target_bid  someone is bidding at or above your target — sell now;
 *   undercut    units are listed below your target, so you are not first;
 *   stale       it has taken far longer than it was expected to sell.
 */

export type ExitKind = "target_bid" | "undercut" | "stale";

export interface ExitSignal {
  kind: ExitKind;
  label: string;
  detail: string;
  /** The level it fired at: the bid, or the cheapest undercutting ask. */
  value: number | null;
  whisper?: string;
  buyer?: { userId: string; ingameName: string; platinum: number };
}

export interface ExitPolicy {
  /** Flag a position older than this, whatever the estimate said. */
  staleAfterDays: number;
  /** ...or once it has taken this many times its expected selling time. */
  staleMultiple: number;
  /** Smallest meaningful overrun before a fast trade is called stale. */
  minOverrunDays: number;
}

/** Guesses, like every other threshold here — the journal will say. */
export const DEFAULT_EXIT_POLICY: ExitPolicy = { staleAfterDays: 3, staleMultiple: 2, minOverrunDays: 1 / 3 };

export interface Position {
  tradeId: number;
  itemId: string;
  variant: string;
  name: string;
  quantity: number;
  /** What it is meant to sell at: target_price, else the model's expected_sell. */
  target: number | null;
  heldH: number;
}

export interface PositionMarket {
  /** Reachable bids, highest first. */
  bids: BookOrder[];
  /** Reachable asks, cheapest first. */
  asks: BookOrder[];
  /** Expected days to sell at the target, from the queue ahead of it. */
  expectedDays: number | null;
}

const fmtDays = formatDuration;

export function exitSignals(
  p: Position,
  m: PositionMarket,
  policy: ExitPolicy = DEFAULT_EXIT_POLICY,
): ExitSignal[] {
  const out: ExitSignal[] = [];

  const bid = m.bids[0];
  if (p.target !== null && bid && bid.platinum >= p.target) {
    const wants = bid.quantity;
    out.push({
      kind: "target_bid",
      label: "Sell now",
      detail:
        `${bid.ingameName} bids ${bid.platinum}p, at or above your ${p.target}p target` +
        (wants !== null && wants < p.quantity ? ` — wants ${wants} of your ${p.quantity}` : ""),
      value: bid.platinum,
      // Selling to a buy order is filling it at THEIR price — never offer less.
      whisper: whisperFor(bid.ingameName, p.name, bid.platinum, "sell"),
      buyer: { userId: bid.userId, ingameName: bid.ingameName, platinum: bid.platinum },
    });
  }

  if (p.target !== null) {
    const below = unitsBelow(m.asks, p.target);
    if (below > 0) {
      out.push({
        kind: "undercut",
        label: "Undercut",
        detail: `${below} listed below your ${p.target}p target, cheapest ${m.asks[0]!.platinum}p`,
        value: m.asks[0]!.platinum,
      });
    }
  }

  const heldDays = p.heldH / 24;
  // Either condition is enough: a hard maximum hold, or a meaningful overrun
  // of the market estimate. The old max() required BOTH and hid fast failures.
  const limit = m.expectedDays === null
    ? policy.staleAfterDays
    : Math.min(policy.staleAfterDays, Math.max(policy.minOverrunDays, policy.staleMultiple * m.expectedDays));
  if (heldDays > limit) {
    out.push({
      kind: "stale",
      label: "Sitting",
      detail:
        `held ${fmtDays(heldDays)}` +
        (m.expectedDays !== null && p.target !== null
          ? ` against about ${fmtDays(m.expectedDays)} expected at ${p.target}p`
          : "") +
        " — worth re-pricing, or cutting it loose",
      value: null,
    });
  }

  return out;
}

/** Every open position, with the target its alerts fire against. */
export function openPositions(db: Db, now = Date.now()): Position[] {
  const rows = db
    .prepare(
      `SELECT t.id AS tradeId, t.item_id AS itemId, t.variant, i.name, t.quantity,
              COALESCE(t.target_price, t.expected_sell) AS target, t.bought_at AS boughtAt
         FROM trade t JOIN item i ON i.id = t.item_id
        WHERE t.sold_at IS NULL`,
    )
    .all() as Array<Omit<Position, "heldH"> & { boughtAt: string }>;
  return rows.map(({ boughtAt, ...p }) => ({ ...p, heldH: (now - Date.parse(boughtAt)) / 3_600_000 }));
}

/** Signals for each position, keyed by trade id. */
export function evaluatePositions(
  db: Db,
  positions: Position[],
  now = Date.now(),
  policy: ExitPolicy = DEFAULT_EXIT_POLICY,
): Map<number, ExitSignal[]> {
  const read = bookReader(db, now);
  const stat = db.prepare(
    `SELECT volume_48h AS volume48h, volume_7d AS volume7d,
            days_traded_30d AS daysTraded30d, median_7d AS median7d
       FROM stat_summary WHERE item_id = ? AND variant = ?`,
  );
  const out = new Map<number, ExitSignal[]>();
  for (const p of positions) {
    const asks = read(p.itemId, p.variant, "sell");
    const bids = read(p.itemId, p.variant, "buy");
    const s = stat.get(p.itemId, p.variant) as
      | { volume48h: number; volume7d: number; daysTraded30d: number; median7d: number | null }
      | undefined;
    const expectedDays =
      p.target === null || !s
        ? null
        : sellTime({
            ...s,
            queue: unitsBelow(asks, p.target),
            sellAt: p.target,
            tradedMedian: s.median7d,
          }).days;
    out.set(p.tradeId, exitSignals(p, { bids, asks, expectedDays }, policy));
  }
  return out;
}

/**
 * The signals not yet sent, recorded as sent.
 *
 * A better bid, or a deeper undercut, fires again; a signal whose condition has
 * cleared is forgotten, so it can fire anew if it comes back. "Stale" fires
 * once per position.
 */
export function unsentSignals(
  db: Db,
  evaluated: Map<number, ExitSignal[]>,
  now = Date.now(),
): Array<{ tradeId: number; signal: ExitSignal }> {
  const get = db.prepare("SELECT value FROM exit_alert WHERE trade_id = ? AND kind = ?");
  const put = db.prepare(
    `INSERT INTO exit_alert (trade_id, kind, value, fired_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(trade_id, kind) DO UPDATE SET value = excluded.value, fired_at = excluded.fired_at`,
  );
  const clear = db.prepare("DELETE FROM exit_alert WHERE trade_id = ? AND kind = ?");
  const at = new Date(now).toISOString();
  const fresh: Array<{ tradeId: number; signal: ExitSignal }> = [];

  db.transaction(() => {
    for (const [tradeId, signals] of evaluated) {
      for (const kind of ["target_bid", "undercut"] as const) {
        if (!signals.some((s) => s.kind === kind)) clear.run(tradeId, kind);
      }
      for (const s of signals) {
        const prev = get.get(tradeId, s.kind) as { value: number | null } | undefined;
        const fire =
          !prev ||
          (s.kind === "target_bid" && s.value !== null && prev.value !== null && s.value > prev.value) ||
          (s.kind === "undercut" && s.value !== null && prev.value !== null && s.value < prev.value);
        if (!fire) continue;
        put.run(tradeId, s.kind, s.value, at);
        fresh.push({ tradeId, signal: s });
      }
    }
  })();
  return fresh;
}

/** The notification for a signal — the whisper travels with the one you act on. */
export function exitNotice(name: string, s: ExitSignal): Notice {
  if (s.kind === "target_bid") {
    return {
      title: `Sell ${name} now: ${s.buyer!.ingameName} bids ${s.value}p`,
      body: s.detail,
      ...(s.whisper ? { whisper: s.whisper } : {}),
    };
  }
  if (s.kind === "undercut") return { title: `${name} undercut at ${s.value}p`, body: s.detail };
  return { title: `${name} is sitting unsold`, body: s.detail };
}
