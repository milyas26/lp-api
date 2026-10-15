import { toJson, type PrismaClient } from "../../../shared/prisma";
import type { JournalEntry } from "../domain/journal-entry";
import type { JournalRepository } from "../domain/journal.repository";

export class PrismaJournalRepository implements JournalRepository {
  constructor(private readonly db: PrismaClient) {}

  async append(e: JournalEntry): Promise<void> {
    await this.db.journalEntry.create({
      data: {
        ts: new Date(e.ts),
        type: e.type,
        pool: typeof e.pool === "string" ? e.pool : null,
        position: typeof e.position === "string" ? e.position : null,
        data: toJson(e),
      },
    });
  }

  async tail(limit: number, type?: string): Promise<JournalEntry[]> {
    const rows = await this.db.journalEntry.findMany({
      where: type ? { type } : undefined,
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      take: limit,
    });
    return rows.map((r) => r.data as unknown as JournalEntry);
  }
}
