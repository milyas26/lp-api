import type { Features } from "../../strategy/domain/features";
import type { Pool } from "../../screening/domain/pool";
import type { Plan } from "../../strategy/domain/playbook";

/** A fully specified entry, ready for LpAgent.open(). Built by the rule engine or the AI decision loop. */
export interface EntryProposal {
  pool: Pool;
  features: Features;
  plan: Plan;
  bins: number;
  sizeSol: number;
  rug: { dangers: string[]; warnings: string[] };
  pvp: number;
  reasoning: string;
  decidedBy: "ai" | "rules";
  /** AI confidence 0..1 (AI path only). */
  confidence?: number;
}
