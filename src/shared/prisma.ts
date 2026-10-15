import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client";

export type { PrismaClient };

export function createPrisma(databaseUrl: string): PrismaClient {
  // The pg adapter sends Dates as UTC wall-clock text without an offset, so a server
  // whose TimeZone is not UTC (e.g. Asia/Jakarta) would shift every timestamptz.
  const adapter = new PrismaPg({ connectionString: databaseUrl, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}

/** Domain objects are plain JSON-safe data; this narrows them for Prisma Json columns. */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Database name only, for display: never the password or host. */
export function databaseLabel(databaseUrl: string): string {
  try {
    return `PostgreSQL (${decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "")) || "postgres"})`;
  } catch {
    return "PostgreSQL";
  }
}
