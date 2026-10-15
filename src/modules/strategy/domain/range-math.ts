/**
 * Modul 2.2: range% = 1 − (1 + binStep/10000)^(−bins)
 * so bins = −ln(1 − range) / ln(1 + binStep/10000).
 */
export function binsForPct(rangePct: number, binStep: number): number {
  const r = Math.min(0.99, Math.max(0.001, rangePct / 100));
  return Math.max(1, Math.ceil(-Math.log(1 - r) / Math.log(1 + binStep / 10_000)));
}

export function pctForBins(bins: number, binStep: number): number {
  return (1 - Math.pow(1 + binStep / 10_000, -bins)) * 100;
}

/** Smallest share of the requested range we accept when shrinking it to fit the bin cap. */
export const MIN_RANGE_KEEP = 0.7;

export interface FittedRange {
  rangePct: number;
  bins: number;
  /** Range was narrowed to fit `maxBins`. */
  shrunk: boolean;
  /** False when even the narrowed range is too far from the request (or below 15%). */
  ok: boolean;
}

/**
 * Narrow a range to the widest one that fits `maxBins` at this bin step,
 * instead of rejecting it. E.g. -65% at bin step 100 needs 106 bins; with a
 * cap of 80 it becomes -55% (80 bins).
 */
export function fitRange(rangePct: number, binStep: number, maxBins: number): FittedRange {
  const bins = binsForPct(rangePct, binStep);
  if (bins <= maxBins) return { rangePct, bins, shrunk: false, ok: true };
  const fitted = pctForBins(maxBins, binStep);
  return { rangePct: fitted, bins: maxBins, shrunk: true, ok: fitted >= 15 && fitted >= rangePct * MIN_RANGE_KEEP };
}

export interface BinRange {
  minBinId: number;
  maxBinId: number;
  bins: number;
}

/**
 * One-sided SOL range sitting just below the current token price.
 * SOL as Y → bins below the active bin; SOL as X → bins above it
 * (the pool price is SOL-per-token inverted, so "token down" = bin id up).
 */
export function solSideRange(activeBinId: number, bins: number, solIsX: boolean): BinRange {
  if (solIsX) {
    return { minBinId: activeBinId + 1, maxBinId: activeBinId + bins, bins };
  }
  return { minBinId: activeBinId - bins, maxBinId: activeBinId - 1, bins };
}

/**
 * How deep the price sits inside a SOL-side range, from the token's view:
 * 0 = at/above the top (nothing filled), 1 = at/below the bottom (fully token).
 * Negative = above range, >1 = below range.
 */
export function depthInRange(activeBinId: number, r: BinRange, solIsX: boolean): number {
  const span = r.maxBinId - r.minBinId + 1;
  const stepsDown = solIsX ? activeBinId - r.minBinId + 1 : r.maxBinId - activeBinId + 1;
  return stepsDown / span;
}
