import type { Market } from "../../market/domain/market";
import type { TrackedPosition } from "../../positions/domain/position";
import type { BotState } from "../domain/bot-state";

export interface Bankroll {
  freeSol: number;
  deployedSol: number;
  totalSol: number;
  at: number;
}

/**
 * In-memory view of the running bot, shared by the use cases of one process.
 * Persistent parts (state, positions) are written through their repositories.
 */
export class BotSession {
  market: Market | null = null;
  bankroll: Bankroll | null = null;
  /** Open positions as of the last load or change. */
  positions: TrackedPosition[] = [];
  /** Pool address → when a candidate was last skipped (30 min re-check cooldown). */
  readonly skippedAt = new Map<string, number>();

  constructor(public state: BotState) {}
}
