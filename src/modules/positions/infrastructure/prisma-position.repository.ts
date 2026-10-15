import { toJson, type PrismaClient } from "../../../shared/prisma";
import type { TrackedPosition } from "../domain/position";
import type { ClosedPositionView, PositionRepository } from "../domain/position.repository";

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly db: PrismaClient) {}

  async findOpen(): Promise<TrackedPosition[]> {
    const rows = await this.db.position.findMany({ where: { status: "open" }, orderBy: { openedAt: "asc" } });
    return rows.map((r) => r.data as unknown as TrackedPosition);
  }

  async save(p: TrackedPosition): Promise<void> {
    const data = toJson(p);
    await this.db.position.upsert({
      where: { pubkey: p.positionPubkey },
      create: {
        pubkey: p.positionPubkey,
        poolAddress: p.poolAddress,
        poolName: p.poolName,
        tokenMint: p.tokenMint,
        tokenSymbol: p.tokenSymbol,
        strategy: p.strategy,
        shape: p.shape,
        binStep: p.binStep ?? null,
        decidedBy: p.decidedBy ?? null,
        depositSol: p.depositSol,
        paper: !!p.paper,
        status: "open",
        openedAt: new Date(p.openedAt),
        data,
      },
      update: { data },
    });
  }

  async markClosed(pubkey: string, reason: string, realizedSol: number | null): Promise<void> {
    await this.db.position.updateMany({
      where: { pubkey },
      data: { status: "closed", closedAt: new Date(), closeReason: reason, realizedSol },
    });
  }

  async recentClosed(limit: number): Promise<ClosedPositionView[]> {
    const rows = await this.db.position.findMany({
      where: { status: "closed" },
      orderBy: { closedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      position: r.data as unknown as TrackedPosition,
      closedAt: (r.closedAt ?? r.updatedAt).getTime(),
      closeReason: r.closeReason,
      realizedSol: r.realizedSol,
    }));
  }
}
