import { existsSync, readFileSync } from "node:fs";
import { log } from "../../../shared/logger";
import type { JournalEntry } from "../../journal/domain/journal-entry";
import type { JournalRepository } from "../../journal/domain/journal.repository";
import type { TrackedPosition } from "../../positions/domain/position";
import type { PositionRepository } from "../../positions/domain/position.repository";
import { freshBotState, type BotState } from "../domain/bot-state";
import type { BotStateRepository } from "../domain/bot-state.repository";

/**
 * One-off move from the old JSON files (data/state.json, data/journal.jsonl)
 * into the database. Only fills tables that are still empty.
 */
export class ImportLegacy {
  constructor(
    private readonly botState: BotStateRepository,
    private readonly positions: PositionRepository,
    private readonly journal: JournalRepository,
  ) {}

  async execute(statePath: string, journalPath: string): Promise<void> {
    if (existsSync(statePath)) {
      const empty = !(await this.botState.load()) && (await this.positions.findOpen()).length === 0;
      if (empty) {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BotState> & {
          positions?: Record<string, TrackedPosition>;
        };
        const state: BotState = { ...freshBotState(), ...raw };
        await this.botState.save({ day: state.day, closedPoolAt: state.closedPoolAt, paperBalanceSol: state.paperBalanceSol });
        const open = Object.values(raw.positions ?? {});
        for (const p of open) await this.positions.save(p);
        log.info(`imported ${statePath}: ${open.length} open positions`);
      } else {
        log.info("database already has bot state, state file not imported");
      }
    }

    if (existsSync(journalPath)) {
      if ((await this.journal.tail(1)).length > 0) {
        log.info("database already has journal entries, journal file not imported");
        return;
      }
      let n = 0;
      for (const line of readFileSync(journalPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          await this.journal.append(JSON.parse(line) as JournalEntry);
          n++;
        } catch {
          // skip a partially written line
        }
      }
      log.info(`imported ${n} journal entries from ${journalPath}`);
    }
  }
}
