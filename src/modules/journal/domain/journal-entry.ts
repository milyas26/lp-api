/** Modul 9.7 #9: "Catat semua trade". */
export type JournalType = "open" | "close" | "claim" | "skip" | "halt";

export interface JournalEvent {
  type: JournalType;
  pool?: string;
  position?: string;
  [k: string]: unknown;
}

export interface JournalEntry extends JournalEvent {
  ts: string;
}
