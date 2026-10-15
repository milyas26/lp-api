import { log } from "../../../shared/logger";
import type { BotSession } from "../../bot/application/bot-session";
import type { JournalService } from "../../journal/application/journal.service";
import type { Pool } from "../domain/pool";

/** Candidates skipped within this window are not re-checked. */
export const SKIP_COOLDOWN_MS = 30 * 60_000;

/** One place for "this candidate was skipped": log, journal, and the re-check cooldown. */
export class CandidateSkips {
  constructor(
    private readonly session: BotSession,
    private readonly journal: JournalService,
  ) {}

  async record(pool: Pool, why: string, extra: Record<string, unknown> = {}): Promise<void> {
    log.info(`skip ${pool.name}: ${why}`);
    this.session.skippedAt.set(pool.address, Date.now());
    await this.journal.record({ type: "skip", pool: pool.name, address: pool.address, why, ...extra });
  }

  coolingDown(address: string, now = Date.now()): boolean {
    const at = this.session.skippedAt.get(address);
    return !!at && now - at < SKIP_COOLDOWN_MS;
  }
}
