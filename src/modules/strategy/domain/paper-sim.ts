import { binsForPct } from "./range-math";
import type { ShapeName } from "./shape";

/**
 * Paper-trading model of a one-sided SOL position below price (DRY_RUN).
 * Each bin i (0 = top) is a buy order at pTop·(1+s)^−i. Once price trades
 * below a bin, that bin's SOL has become token bought at the bin price.
 * Fees are estimated from the pool's realised fee/TVL while in range, scaled
 * by how concentrated our liquidity is in the active bin (feeConcentration).
 */
export interface PaperState {
  depositSol: number;
  priceTop: number;
  binStep: number;
  bins: number;
  shape: ShapeName;
  feesSol: number;
  lastTickAt: number;
}

function weights(n: number, shape: ShapeName): number[] {
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    if (shape === "BidAsk") w.push(i + 1); // more SOL at the bottom
    else if (shape === "Curve") w.push(Math.max(1, n / 2 - Math.abs(i - (n - 1) / 2)));
    else w.push(1);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

export function paperValue(s: PaperState, price: number): { liquiditySol: number; depth: number } {
  const w = weights(s.bins, s.shape);
  const step = 1 + s.binStep / 10_000;
  let value = 0;
  let filled = 0;
  for (let i = 0; i < s.bins; i++) {
    const binPrice = s.priceTop * Math.pow(step, -i);
    const sol = w[i] * s.depositSol;
    if (price < binPrice) {
      value += (sol / binPrice) * price;
      filled++;
    } else {
      value += sol;
    }
  }
  const depth = price >= s.priceTop ? 0 : Math.log(s.priceTop / price) / Math.log(step) / s.bins;
  return { liquiditySol: value, depth: filled === 0 ? Math.min(depth, 0) : depth };
}

/**
 * Pool fee/TVL is earned at the baseline density: Spot -50%, the old default
 * width. A tighter range (or the heavy end of a Curve/BidAsk) puts more SOL in
 * the active bin and takes a bigger share of each swap. Capped because other
 * LPs in the same bin dilute us long before the ratio gets extreme.
 */
const BASELINE_RANGE_PCT = 50;
const MAX_CONCENTRATION = 4;

/** Average fee multiplier over the whole range vs the Spot -50% baseline. */
export function rangeConcentration(bins: number, binStep: number): number {
  return Math.min(MAX_CONCENTRATION, binsForPct(BASELINE_RANGE_PCT, binStep) / Math.max(1, bins));
}

/** Fee multiplier for the bin price sits in now; 0 outside the range. */
export function feeConcentration(s: PaperState, depth: number): number {
  if (depth <= 0 || depth > 1) return 0;
  const i = Math.min(s.bins - 1, Math.floor(depth * s.bins));
  return Math.min(MAX_CONCENTRATION, weights(s.bins, s.shape)[i] * binsForPct(BASELINE_RANGE_PCT, s.binStep));
}

/** Accrue estimated fees: deposit × pool fee/TVL rate × concentration, only while in range. */
export function paperAccrue(s: PaperState, price: number, poolFeeTvl1hPct: number, now: number): void {
  const { depth } = paperValue(s, price);
  const k = feeConcentration(s, depth);
  const hours = (now - s.lastTickAt) / 3_600_000;
  if (k > 0 && hours > 0) s.feesSol += s.depositSol * (poolFeeTvl1hPct / 100) * k * hours;
  s.lastTickAt = now;
}
