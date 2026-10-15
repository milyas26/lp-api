import type { Tracer } from "../../activity/application/tracer";
import type { JournalService } from "../../journal/application/journal.service";
import type { ManagePositions } from "../../positions/application/manage-positions.use-case";
import type { BotStateRepository } from "../domain/bot-state.repository";
import type { BotSession } from "./bot-session";

/** Emergency exit: close every position the bot opened and zap out (`npm run close-all`). */
export class CloseAll {
  constructor(
    private readonly session: BotSession,
    private readonly botState: BotStateRepository,
    private readonly managePositions: ManagePositions,
    private readonly journal: JournalService,
    private readonly tracer: Tracer,
  ) {}

  async execute(reason: string): Promise<void> {
    this.tracer.startCycle();
    try {
      await this.managePositions.closeEverything();
      await this.botState.save(this.session.state);
      await this.journal.record({ type: "halt", reason });
      this.tracer.endCycle(false);
    } catch (e) {
      this.tracer.endCycle(true);
      throw e;
    }
  }
}
