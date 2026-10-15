import type { AgentConfig } from "../../../shared/config";
import type { ShapeName } from "./shape";
import type { Features } from "./features";

/** Modul 7.1 token lifecycle. */
export type Phase =
  | "RUNUP" // fase 1: run-up awal / breakout ATH
  | "POST_TOP" // fase 2/3: baru nge-top atau kita ketinggalan run-up
  | "DUMPED_RANGING" // fase 4: udah dump gede, mulai ranging
  | "MATURE_RANGING" // fase 5: ranging lama, masih ada volume
  | "FALLING_KNIFE" // lagi jebol, belum stabil
  | "DEAD"; // fase 6: volume & volatilitas hilang

export type StrategyId =
  | "S2_WIDE_BIDASK"
  | "S1_PLAY_THE_DROP"
  | "S10_POST_DUMP_SPOT"
  | "S8_SLOW_COOK"
  | "S4_HEART_ATTACK";

export interface ExitRules {
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldHours: number;
  /** Minutes allowed fully below range before cutting (Dog lesson: no bag-holding). */
  outBelowMaxMin: number;
  /** Close after the bounce once price went at least this deep (0..1) ... */
  bounceDepth: number;
  /** ... and came back up to this depth with profit (Modul 8.5: "balik ke tengah range"). */
  bounceExitDepth: number;
}

export interface Plan {
  strategy: StrategyId;
  phase: Phase;
  shape: ShapeName;
  rangePct: number;
  sizeFactor: number;
  exits: ExitRules;
  notes: string[];
}

/** Exit templates per strategy (Modul 8.5 / 9.2), fixed before entry. */
export const STRATEGY_EXITS: Record<StrategyId, ExitRules> = {
  S4_HEART_ATTACK: {
    stopLossPct: 6,
    takeProfitPct: 8,
    maxHoldHours: 2,
    outBelowMaxMin: 0,
    bounceDepth: 99,
    bounceExitDepth: 0,
  },
  S1_PLAY_THE_DROP: {
    stopLossPct: 20,
    takeProfitPct: 15,
    maxHoldHours: 24,
    outBelowMaxMin: 30,
    bounceDepth: 0.35,
    bounceExitDepth: 0.1,
  },
  S2_WIDE_BIDASK: {
    stopLossPct: 22,
    takeProfitPct: 20,
    maxHoldHours: 72,
    outBelowMaxMin: 45,
    bounceDepth: 0.35,
    bounceExitDepth: 0.1,
  },
  S10_POST_DUMP_SPOT: {
    stopLossPct: 15,
    takeProfitPct: 12,
    maxHoldHours: 24,
    outBelowMaxMin: 20,
    bounceDepth: 0.5,
    bounceExitDepth: 0.25,
  },
  S8_SLOW_COOK: {
    stopLossPct: 15,
    takeProfitPct: 25,
    maxHoldHours: 24 * 7,
    outBelowMaxMin: 60,
    bounceDepth: 99,
    bounceExitDepth: 0,
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGY_EXITS) as StrategyId[];

export function classifyPhase(f: Features, cfg: AgentConfig): Phase {
  if (f.volume1hUsd < cfg.screening.minVolume1hUsd || f.volumeTrend < cfg.risk.volumeDecayRatio) {
    return "DEAD";
  }
  if (f.change1hPct <= -25 && !f.stabilized) return "FALLING_KNIFE";
  if (f.ageHours >= 72 && f.range24hPct < 45 && Math.abs(f.change24hPct) < 25 && f.stabilized) {
    return "MATURE_RANGING";
  }
  if (f.drawdownFromAthPct >= 55 && f.stabilized) return "DUMPED_RANGING";
  if (f.drawdownFromAthPct < 8 && f.change6hPct > 40) return "RUNUP";
  if (f.drawdownFromAthPct >= 55) return "FALLING_KNIFE";
  return "POST_TOP";
}

/** Modul 7.2 / 9.1: bigger caps → narrower range; small, fresh, risky → wider. */
const MAX_WIDE_RANGE_PCT = 55;

function bidAskWidth(f: Features, rugWarnings: number): number {
  let w = f.mcapUsd >= 100e6 ? 35 : f.mcapUsd >= 20e6 ? 45 : 50;
  if (f.ageHours < 72) w += 5;
  if (rugWarnings > 0) w += 5;
  // Modul 7.3: bottom of the range goes below visible support (24h low) with ~10% buffer.
  const toSupport = (1 - (f.low24hSol * 0.9) / f.priceSol) * 100;
  if (toSupport > w && toSupport < 85) w = toSupport;
  // -55% at bin step 100 = 80 bins, so the range fits without an extended position.
  return Math.min(MAX_WIDE_RANGE_PCT, w);
}

export function buildPlan(
  f: Features,
  phase: Phase,
  cfg: AgentConfig,
  rugWarnings: number,
): Plan | null {
  switch (phase) {
    case "DEAD":
    case "FALLING_KNIFE":
      return null;

    case "RUNUP":
      if (cfg.opening.allowAggressive && f.volume1hUsd >= 3_000_000) {
        // S4: tight spot on the run-up, out at the first breakdown.
        return {
          strategy: "S4_HEART_ATTACK",
          phase,
          shape: "Spot",
          rangePct: 20,
          sizeFactor: 0.5,
          exits: { ...STRATEGY_EXITS.S4_HEART_ATTACK },
          notes: ["run-up + volume ≥ $50k/min, tight spot, exit on breakdown"],
        };
      }
      // Missed the run-up → bid-ask, wait for it to come down to us.
      return wideBidAsk(f, phase, rugWarnings, ["ketinggalan run-up → bid-ask lebar"]);

    case "POST_TOP":
      if (f.mcapUsd >= 20e6 && f.swing15mPct >= 3) {
        return {
          strategy: "S1_PLAY_THE_DROP",
          phase,
          shape: "BidAsk",
          rangePct: bidAskWidth(f, rugWarnings),
          sizeFactor: 1,
          exits: { ...STRATEGY_EXITS.S1_PLAY_THE_DROP },
          notes: ["big cap post-top, play the drop"],
        };
      }
      return wideBidAsk(f, phase, rugWarnings, ["post-top, bid-ask lebar set & forget"]);

    case "DUMPED_RANGING":
      return {
        strategy: "S10_POST_DUMP_SPOT",
        phase,
        shape: "Spot",
        rangePct: 50,
        sizeFactor: 0.7,
        exits: { ...STRATEGY_EXITS.S10_POST_DUMP_SPOT },
        notes: [`drawdown ${f.drawdownFromAthPct.toFixed(0)}% & stabil → spot −50%`],
      };

    case "MATURE_RANGING":
      return {
        strategy: "S8_SLOW_COOK",
        phase,
        shape: "Spot",
        rangePct: Math.min(MAX_WIDE_RANGE_PCT, Math.max(40, f.range24hPct * 1.3)),
        sizeFactor: 1,
        exits: { ...STRATEGY_EXITS.S8_SLOW_COOK },
        notes: ["token lama ranging, slow cook"],
      };
  }
}

function wideBidAsk(f: Features, phase: Phase, rugWarnings: number, notes: string[]): Plan {
  return {
    strategy: "S2_WIDE_BIDASK",
    phase,
    shape: "BidAsk",
    rangePct: bidAskWidth(f, rugWarnings),
    sizeFactor: 1,
    exits: { ...STRATEGY_EXITS.S2_WIDE_BIDASK },
    notes,
  };
}

/** Modul 9.1: size per market cap, as a fraction of bankroll. */
export function baseSizePct(mcapUsd: number): number {
  if (mcapUsd >= 50e6) return 12;
  if (mcapUsd >= 10e6) return 8;
  if (mcapUsd >= 3e6) return 5;
  return 3;
}
