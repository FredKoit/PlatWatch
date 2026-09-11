/**
 * Results-based ranking: what your own closed trades say each strategy really
 * makes, applied back to the rankings and the budget plan.
 *
 * The ranking predicts a profit for every trade and the journal records what it
 * realised. If spread trades keep landing at 60% of the prediction, spread rows
 * should rank as if they make 60% — but not after two trades. A handful of
 * results is noise, and one lucky sale would promote a strategy that
 * overestimates everything else.
 *
 * So the factor starts at ×1 and moves toward the realised ratio as trades
 * accumulate, weighted as if PRIOR_TRADES trades had already landed exactly on
 * the prediction: 10 closed trades move it halfway there, 40 move it 80% of
 * the way. The ranking's gates still use the predicted margin; only the order
 * and the plan's expected profit change.
 */

export const PRIOR_TRADES = 10;

/** One freak result must not triple a strategy or flip its sign. */
const MAX_RATIO = 2;

export function calibrationFactor(
  closed: number,
  ratio: number | null,
  prior: number = PRIOR_TRADES,
): number {
  if (ratio === null || !Number.isFinite(ratio) || closed <= 0) return 1;
  const r = Math.min(MAX_RATIO, Math.max(0, ratio));
  return Number(((closed * r + prior) / (closed + prior)).toFixed(3));
}

export function calibrationNote(
  source: string,
  closed: number,
  ratio: number | null,
  factor: number,
): string {
  if (closed === 0 || ratio === null) return `no closed ${source} trades yet — ranked as predicted`;
  const n = `${closed} closed ${source} trade${closed === 1 ? "" : "s"}`;
  return (
    `your ${n} realised ${Math.round(ratio * 100)}% of the predicted profit, ` +
    `so ${source} rows rank at ×${factor.toFixed(2)}` +
    (closed < PRIOR_TRADES ? " — too few yet to move it far" : "")
  );
}

export interface StrategyFactor {
  factor: number;
  closed: number;
  note: string;
}

/** A strategy's expected profit per trade, once your record has had its say. */
export function calibrated(margin: number, f: StrategyFactor | undefined): number {
  return f ? Math.round(margin * f.factor) : margin;
}
