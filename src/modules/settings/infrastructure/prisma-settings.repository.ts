import { toJson, type PrismaClient } from "../../../shared/prisma";
import type { SettingsRepository } from "../domain/settings.repository";

export class PrismaSettingsRepository implements SettingsRepository {
  constructor(private readonly db: PrismaClient) {}

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.setting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async apply(changes: Record<string, unknown | null>): Promise<void> {
    await this.db.$transaction(
      Object.entries(changes).map(([key, value]) =>
        value === null
          ? this.db.setting.deleteMany({ where: { key } })
          : this.db.setting.upsert({
              where: { key },
              create: { key, value: toJson(value) },
              update: { value: toJson(value) },
            }),
      ),
    );
  }
}
