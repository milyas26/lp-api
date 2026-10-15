import { toJson, type PrismaClient } from "../../../shared/prisma";
import type { BotState, DayStats } from "../domain/bot-state";
import type { BotStateRepository } from "../domain/bot-state.repository";

const ROW_ID = 1;

export class PrismaBotStateRepository implements BotStateRepository {
  constructor(private readonly db: PrismaClient) {}

  async load(): Promise<BotState | null> {
    const row = await this.db.botState.findUnique({ where: { id: ROW_ID } });
    if (!row) return null;
    return {
      day: row.day as unknown as DayStats,
      closedPoolAt: row.closedPoolAt as unknown as Record<string, number>,
      ...(row.paperBalanceSol != null ? { paperBalanceSol: row.paperBalanceSol } : {}),
    };
  }

  async save(state: BotState): Promise<void> {
    const data = {
      day: toJson(state.day),
      closedPoolAt: toJson(state.closedPoolAt),
      paperBalanceSol: state.paperBalanceSol ?? null,
    };
    await this.db.botState.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data }, update: data });
  }
}
