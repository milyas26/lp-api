import type { AgentConfig } from "../../../shared/config";
import { log } from "../../../shared/logger";
import type { Tracer } from "../../activity/application/tracer";
import type { BotStatus, Cycle } from "../../activity/domain/cycle";
import type { EntryDecider } from "../../decision/domain/entry-decider";
import type { Market } from "../../market/domain/market";
import type { TrackedPosition } from "../../positions/domain/position";
import type { DayStats } from "../domain/bot-state";
import type { Bankroll, BotSession } from "./bot-session";

/** What the dashboard shows; mirrored in frontend/src/types.ts. */
export interface BotSnapshot {
  dryRun: boolean;
  wallet: string;
  llm: string | null;
  storage: string;
  /** "ai" = DeepSeek decision loop picks entries; "rules" = playbook rule engine only. */
  decisionMode: "ai" | "rules";
  intervalMs: number;
  day: DayStats;
  bankroll: Bankroll | null;
  market: Market | null;
  positions: TrackedPosition[];
  limits: {
    maxPositions: number;
    dailyLossLimitSol: number;
    maxDeployedPct: number;
    maxBinsPerPosition: number;
  };
}

export interface Overview {
  status: BotStatus;
  snapshot: BotSnapshot;
  cycles: Cycle[];
}

/** Read side for the dashboard plus its one control (pause new entries). */
export class BotOverview {
  constructor(
    private readonly cfg: AgentConfig,
    private readonly session: BotSession,
    private readonly tracer: Tracer,
    private readonly decider: EntryDecider,
    private readonly wallet: string,
    private readonly storage: string,
  ) {}

  snapshot(): BotSnapshot {
    const c = this.cfg;
    return {
      dryRun: c.dryRun,
      wallet: this.wallet,
      llm: this.decider.label,
      storage: this.storage,
      decisionMode: this.decider.mode,
      intervalMs: c.intervalMs,
      day: this.session.state.day,
      bankroll: this.session.bankroll,
      market: this.session.market,
      positions: this.session.positions,
      limits: {
        maxPositions: c.opening.maxPositions,
        dailyLossLimitSol: c.risk.dailyLossLimitSol,
        maxDeployedPct: c.opening.maxDeployedPct,
        maxBinsPerPosition: c.opening.maxBinsPerPosition,
      },
    };
  }

  overview(): Overview {
    return { status: this.tracer.status, snapshot: this.snapshot(), cycles: this.tracer.cycles };
  }

  setOpeningPaused(paused: boolean): BotStatus {
    this.tracer.setStatus({ openingPaused: paused });
    log.warn(`opening ${paused ? "paused" : "resumed"} from dashboard`);
    return this.tracer.status;
  }
}
