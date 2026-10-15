import type { BotState } from "./bot-state";

export interface BotStateRepository {
  /** null when the bot has never saved state. */
  load(): Promise<BotState | null>;
  save(state: BotState): Promise<void>;
}
