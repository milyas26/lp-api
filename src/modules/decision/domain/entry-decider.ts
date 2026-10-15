import type { Candidate } from "../../screening/domain/ranker";
import type { Pool } from "../../screening/domain/pool";
import type { EntryProposal } from "./entry-proposal";

export interface DecisionInput {
  candidates: Candidate[];
  universe: Pool[];
  bankrollSol: number;
  budgetSol: number;
  market: { solChange1h: number; solChange24h: number };
  openPositions: { pool: string; token: string; strategy: string; pnlPct?: number }[];
  /** Records a skipped pool in the journal and the skip cooldown. */
  onSkip: (pool: Pool, why: string, extra?: Record<string, unknown>) => Promise<void>;
}

/** Picks at most one entry per cycle from the screened candidates. */
export interface EntryDecider {
  readonly mode: "ai" | "rules";
  /** Model name for the dashboard, null for the rule engine. */
  readonly label: string | null;
  decide(input: DecisionInput): Promise<EntryProposal | null>;
}
