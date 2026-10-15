import type { JournalEntry } from "./journal-entry";

export interface JournalRepository {
  append(entry: JournalEntry): Promise<void>;
  /** Newest first. */
  tail(limit: number, type?: string): Promise<JournalEntry[]>;
}
