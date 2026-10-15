import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma generate` runs at image build time without a database, so the URL is only set when present;
// migrate commands fail with a clear "no datasource url" error if it is missing.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
