import type { Mutex } from "../../../shared/mutex";
import type { Tracer } from "../../activity/application/tracer";
import type { BotSession } from "../../bot/application/bot-session";
import type { BotStateRepository } from "../../bot/domain/bot-state.repository";
import type { ManagePositions } from "./manage-positions.use-case";

export type ClosePositionResult =
  | { outcome: "not-found" }
  | { outcome: "failed" }
  | { outcome: "closed"; realizedSol: number | null };

/**
 * Close one position on request from the dashboard. Waits for a running cycle
 * to finish (shared lock) so the bot never touches the same position twice,
 * then records the close as its own short cycle in the activity history.
 */
export class ClosePosition {
  constructor(
    private readonly lock: Mutex,
    private readonly session: BotSession,
    private readonly botState: BotStateRepository,
    private readonly managePositions: ManagePositions,
    private readonly tracer: Tracer,
  ) {}

  execute(pubkey: string): Promise<ClosePositionResult> {
    return this.lock.run(async () => {
      if (!this.session.positions.some((p) => p.positionPubkey === pubkey)) return { outcome: "not-found" as const };

      const before = this.tracer.status;
      this.tracer.startCycle();
      let failed = false;
      try {
        const r = await this.managePositions.closeOne(pubkey, "manual");
        await this.botState.save(this.session.state);
        if (!r) return { outcome: "not-found" as const };
        if (!r.closed) {
          failed = true;
          return { outcome: "failed" as const };
        }
        return { outcome: "closed" as const, realizedSol: r.realizedSol ?? null };
      } finally {
        this.tracer.endCycle(failed);
        // Hand the status back to the loop (usually "sleeping" until the next cycle).
        this.tracer.setStatus({ state: before.state, nextCycleAt: before.nextCycleAt });
      }
    });
  }
}
