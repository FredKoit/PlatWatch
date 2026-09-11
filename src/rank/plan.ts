import { returnPerDay, type Confidence } from "./timing";

/**
 * A shortlist for the platinum you actually have.
 *
 * The rankings answer "what is good"; this answers "what do I do with 500p".
 * It walks the ranked trades in order and takes each one that still fits:
 *
 *   - one trade per item — a spread on a set and set arbitrage on the same set
 *     both end with you selling that set, so they compete for the same buyers;
 *   - no item takes more than the per-item limit, COUNTING what you already
 *     hold in it, so a plan cannot quietly double a position you are stuck in;
 *   - a trade that does not fit the budget is skipped, not a stopping point —
 *     a smaller one further down may still fit.
 *
 * One unit each, deliberately, for the reason the ducat plan gives: the book is
 * a handful of orders deep, so clearing out one seller is not the same as
 * buying five at that price.
 */

export interface PlanCandidate {
  itemId: string;
  variant: string;
  buyAt: number;
  /** Profit per trade after calibration against your record. */
  expectedMargin: number;
  sellDays: number | null;
  sellConfidence: Confidence;
}

export type PlanSort = "speed" | "profit" | "return";

export interface PlanOptions {
  budget: number;
  /** Most platinum in any one item, including open positions; null for no limit. */
  maxPerItem: number | null;
  minConfidence: Confidence;
  sortBy: PlanSort;
  /** Platinum already tied up per `itemId|variant`, from open positions. */
  held?: Map<string, number>;
}

export interface Plan<T> {
  picks: Array<T & { runningTotal: number }>;
  budget: number;
  spent: number;
  expectedProfit: number;
  skipped: { overCap: number; held: number; lowConfidence: number; overBudget: number };
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export const keyOf = (c: { itemId: string; variant: string }) => `${c.itemId}|${c.variant}`;

export function planKey(c: PlanCandidate, sortBy: PlanSort): number {
  if (sortBy === "profit") return c.expectedMargin;
  if (sortBy === "return") return c.buyAt > 0 ? c.expectedMargin / c.buyAt : 0;
  return returnPerDay(c.expectedMargin, c.buyAt, c.sellDays);
}

export function planTrades<T extends PlanCandidate>(candidates: T[], opts: PlanOptions): Plan<T> {
  const ordered = candidates
    .filter((c) => c.expectedMargin > 0 && c.buyAt > 0)
    .sort((a, b) => planKey(b, opts.sortBy) - planKey(a, opts.sortBy));

  const picked = new Set<string>();
  const picks: Array<T & { runningTotal: number }> = [];
  const skipped = { overCap: 0, held: 0, lowConfidence: 0, overBudget: 0 };
  let spent = 0;
  let expectedProfit = 0;

  for (const c of ordered) {
    const key = keyOf(c);
    if (picked.has(key)) continue;
    if (RANK[c.sellConfidence] < RANK[opts.minConfidence]) {
      skipped.lowConfidence++;
      continue;
    }
    const already = opts.held?.get(key) ?? 0;
    if (opts.maxPerItem !== null && already + c.buyAt > opts.maxPerItem) {
      if (already > 0 && c.buyAt <= opts.maxPerItem) skipped.held++;
      else skipped.overCap++;
      continue;
    }
    if (spent + c.buyAt > opts.budget) {
      skipped.overBudget++;
      continue;
    }
    picked.add(key);
    spent += c.buyAt;
    expectedProfit += c.expectedMargin;
    picks.push({ ...c, runningTotal: spent });
  }

  return { picks, budget: opts.budget, spent, expectedProfit, skipped };
}
