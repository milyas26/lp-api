import type { ExitRules, Phase, StrategyId } from "../../strategy/domain/playbook";
import type { PaperState } from "../../strategy/domain/paper-sim";
import type { ShapeName } from "../../strategy/domain/shape";

/** A position the bot opened and manages. Paper positions carry their simulation state. */
export interface TrackedPosition {
  positionPubkey: string;
  poolAddress: string;
  poolName: string;
  tokenMint: string;
  tokenSymbol: string;
  solIsX: boolean;
  strategy: StrategyId;
  phase: Phase;
  shape: ShapeName;
  rangePct: number;
  /** Positions opened before the AI decision loop lack these. */
  binStep?: number;
  decidedBy?: "ai" | "rules";
  confidence?: number;
  minBinId: number;
  maxBinId: number;
  entryActiveBinId: number;
  entryPriceSol: number;
  depositSol: number;
  /** Wallet SOL spent to open (deposit + rent + fees), for realised P&L. */
  openCostSol: number;
  /** SOL received from fee claims (after selling token fees). */
  claimedSol: number;
  exits: ExitRules;
  openedAt: number;
  openSigs: string[];
  reasoning: string;

  // live tracking
  maxDepth: number;
  lastPnlPct?: number;
  outBelowSince?: number;
  idleAboveSince?: number;
  /** Price at the previous cycle, for single-candle rug detection. */
  lastPriceSol?: number;
  lastValueSol?: number;
  lastFeesSol?: number;
  lastDepth?: number;
  lastCheckedAt?: number;

  paper?: PaperState;
}

/** Unrealised P&L in SOL from the last check (liquidity + fees + claimed − deposit). */
export function unrealizedSol(p: TrackedPosition): number {
  return (p.lastValueSol ?? p.depositSol) + p.claimedSol - p.depositSol;
}
