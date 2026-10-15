import { log } from "../../../shared/logger";
import type { JournalEntry, JournalEvent } from "../domain/journal-entry";
import type { JournalRepository } from "../domain/journal.repository";

export class JournalService {
  constructor(private readonly repo: JournalRepository) {}

  /** A failed journal write is logged, never allowed to break a trade. */
  async record(event: JournalEvent): Promise<void> {
    try {
      await this.repo.append({ ts: new Date().toISOString(), ...event });
    } catch (e) {
      log.warn("journal write failed", e);
    }
  }

  tail(limit: number, type?: string): Promise<JournalEntry[]> {
    return this.repo.tail(limit, type);
  }
}
