import { toJson, type PrismaClient } from "../../../shared/prisma";
import type { Cycle, Step } from "../domain/cycle";
import type { CycleRepository } from "../domain/cycle.repository";

export class PrismaCycleRepository implements CycleRepository {
  constructor(private readonly db: PrismaClient) {}

  async save(c: Cycle): Promise<void> {
    const data = {
      startedAt: new Date(c.startedAt),
      endedAt: c.endedAt ? new Date(c.endedAt) : null,
      status: c.status,
      steps: toJson(c.steps),
    };
    await this.db.cycle.upsert({ where: { n: c.n }, create: { n: c.n, ...data }, update: data });
  }

  async recent(limit: number): Promise<Cycle[]> {
    const rows = await this.db.cycle.findMany({ orderBy: { n: "desc" }, take: limit });
    return rows
      .map((r) => ({
        n: r.n,
        startedAt: r.startedAt.getTime(),
        ...(r.endedAt ? { endedAt: r.endedAt.getTime() } : {}),
        // A cycle cut off by a restart never got its end written.
        status: (r.status === "running" ? "failed" : r.status) as Cycle["status"],
        steps: r.steps as unknown as Step[],
      }))
      .reverse();
  }
}
