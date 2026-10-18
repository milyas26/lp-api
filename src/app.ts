import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Container } from "./container";
import { log } from "./shared/logger";
import { botRoutes } from "./modules/bot/http/bot.routes";
import { journalRoutes } from "./modules/journal/http/journal.routes";
import { positionsRoutes } from "./modules/positions/http/positions.routes";
import { settingsRoutes } from "./modules/settings/http/settings.routes";

function tokenOk(req: FastifyRequest, expected: string): boolean {
  if (!expected) return true;
  const header = req.headers.authorization ?? "";
  // EventSource cannot send headers, so the stream passes the token as ?token=.
  const query = (req.query as { token?: string } | undefined)?.token ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : query;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when a browser request comes from a page that is not on this machine. */
function foreignOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

/** Dashboard API: monitoring plus controls (pause entries, close a position, edit settings). */
export async function buildApp(c: Container): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { api } = c.cfg;

  await app.register(cors, {
    origin: api.corsOrigin === "*" ? true : api.corsOrigin,
    allowedHeaders: ["authorization", "content-type"],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS" || req.url.startsWith("/api/health")) return;
    if (!tokenOk(req, api.token)) return reply.code(401).send({ error: "token salah atau tidak ada" });
    // Without a token, any web page open in the same browser could call the controls.
    // Only pages served from this machine may change anything then.
    if (!api.token && req.method !== "GET" && foreignOrigin(req)) {
      return reply.code(403).send({ error: "Kontrol tanpa API_TOKEN hanya bisa dari localhost." });
    }
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) log.error("api error", err);
    reply.code(status).send({ error: err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(botRoutes({ overview: c.overview, tracer: c.tracer, walletBalance: c.walletBalance }), { prefix: "/api" });
  await app.register(journalRoutes(c.journal), { prefix: "/api" });
  await app.register(
    positionsRoutes(c.session, c.positionRepo, c.closePosition, c.onchainPositions, c.positionIl, c.positionChart),
    { prefix: "/api" },
  );
  await app.register(settingsRoutes(c.settings, () => c.tracer.snapshotChanged()), { prefix: "/api" });
  return app;
}
