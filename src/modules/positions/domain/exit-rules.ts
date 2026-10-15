import type { AgentConfig } from "../../../shared/config";
import type { TrackedPosition } from "./position";

export interface Snapshot {
  now: number;
  priceSol: number;
  /** 0 = top of range / above, 1 = bottom, >1 below range, <=0 above. */
  depth: number;
  /** (liquidity + unclaimed fees + claimed) vs deposit, %. */
  pnlPct: number;
  poolVolume1hUsd: number;
  poolVolume24hUsd: number;
  /** Worst 15m candle drop in the last hour, % (from candles; 0 if unknown). */
  worstCandleDropPct: number;
}

export interface ExitDecision {
  reason: string;
  /** true = do not wait for anything, market exit (rug / stop). */
  urgent: boolean;
}

/**
 * Modul 8.5 + 9.2: exit rules are decided before entry and executed without
 * debate. Order matters: survival rules first, profit rules after.
 */
export function evaluateExit(p: TrackedPosition, s: Snapshot, cfg: AgentConfig): ExitDecision | null {
  const r = p.exits;

  // Rug in one candle → sell now, don't wait for the bounce (Mao, vid 20).
  const tickDrop = p.lastPriceSol ? (1 - s.priceSol / p.lastPriceSol) * 100 : 0;
  const rugDrop = Math.max(tickDrop, s.worstCandleDropPct);
  if (rugDrop >= cfg.risk.rugCandlePct) {
    return { reason: `rug-candle(-${rugDrop.toFixed(0)}%)`, urgent: true };
  }

  if (s.pnlPct <= -r.stopLossPct) {
    return { reason: `stop-loss(${s.pnlPct.toFixed(1)}%≤-${r.stopLossPct}%)`, urgent: true };
  }

  // Fell out the bottom and stayed there: no bag-holding (Dog 10M→1M).
  if (s.depth > 1 && p.outBelowSince && s.now - p.outBelowSince >= r.outBelowMaxMin * 60_000) {
    return { reason: `out-below ${Math.round((s.now - p.outBelowSince) / 60_000)}m`, urgent: true };
  }

  if (s.pnlPct >= r.takeProfitPct) {
    return { reason: `take-profit(+${s.pnlPct.toFixed(1)}%)`, urgent: false };
  }

  // Dip filled the range, price bounced back up: lock it (S1 / S11 exit).
  if (p.maxDepth >= r.bounceDepth && s.depth <= r.bounceExitDepth && s.pnlPct > 0) {
    return {
      reason: `bounce-exit(depth ${p.maxDepth.toFixed(2)}→${s.depth.toFixed(2)}, +${s.pnlPct.toFixed(1)}%)`,
      urgent: false,
    };
  }

  // Pumped out the top after doing work → all SOL + fees, close and re-range.
  if (s.depth <= 0 && p.maxDepth > 0.05 && s.pnlPct > 0) {
    return { reason: `pumped-out-top(+${s.pnlPct.toFixed(1)}%)`, urgent: false };
  }

  // Never filled and price ran away: capital is idle, free it for a better range.
  if (
    s.depth <= 0 &&
    p.idleAboveSince &&
    s.now - p.idleAboveSince >= cfg.risk.idleAboveMaxMin * 60_000
  ) {
    return { reason: `idle-above ${Math.round((s.now - p.idleAboveSince) / 60_000)}m`, urgent: false };
  }

  // Volume & volatility fading = "these are all just risk signals".
  const avgHourly = s.poolVolume24hUsd / 24;
  if (avgHourly > 0 && s.poolVolume1hUsd / avgHourly < cfg.risk.volumeDecayRatio) {
    return {
      reason: `volume-decay(1h=${(s.poolVolume1hUsd / 1000).toFixed(0)}k vs avg ${(avgHourly / 1000).toFixed(0)}k)`,
      urgent: false,
    };
  }

  if (s.now - p.openedAt >= r.maxHoldHours * 3_600_000) {
    return { reason: `max-hold ${r.maxHoldHours}h`, urgent: false };
  }

  return null;
}

/**
 * Update the per-position trackers used by the rules above. Call before
 * evaluateExit; set `lastPriceSol` only after it (the rug check needs the
 * previous tick).
 */
export function trackSnapshot(p: TrackedPosition, s: Snapshot): void {
  p.maxDepth = Math.max(p.maxDepth, Math.min(s.depth, 1.5));
  if (s.depth > 1) p.outBelowSince ??= s.now;
  else p.outBelowSince = undefined;
  if (s.depth <= 0 && p.maxDepth <= 0.05) p.idleAboveSince ??= s.now;
  else p.idleAboveSince = undefined;
  p.lastPnlPct = s.pnlPct;
}
