import type { FastifyPluginAsync } from "fastify";
import type { ServerResponse } from "node:http";
import type { Tracer } from "../../activity/application/tracer";
import type { BotOverview } from "../application/bot-overview";
import type { WalletBalance } from "../application/wallet-balance";

/** Named event (not an SSE comment) so the dashboard can detect a dead link behind a proxy. */
const HEARTBEAT_MS = 15_000;

export interface BotRoutesDeps {
  overview: BotOverview;
  tracer: Tracer;
  walletBalance: WalletBalance;
}

export const botRoutes =
  ({ overview, tracer, walletBalance }: BotRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    const clients = new Set<ServerResponse>();
    const send = (res: ServerResponse, event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const broadcast = (event: string, data: unknown) => {
      for (const res of clients) send(res, event, data);
    };

    const onCycle = (c: unknown) => broadcast("cycle", c);
    const onStatus = (s: { state: string }) => {
      broadcast("status", s);
      // Positions and bankroll change at the end of a cycle.
      if (s.state === "sleeping") broadcast("snapshot", overview.snapshot());
    };
    const onSnapshot = () => broadcast("snapshot", overview.snapshot());
    tracer.on("cycle", onCycle);
    tracer.on("status", onStatus);
    tracer.on("snapshot", onSnapshot);
    // preClose, not onClose: server.close() waits for open sockets, and an SSE stream
    // never ends on its own, so shutdown would hang serving stale data to the dashboard.
    app.addHook("preClose", async () => {
      tracer.off("cycle", onCycle);
      tracer.off("status", onStatus);
      tracer.off("snapshot", onSnapshot);
      for (const res of clients) res.end();
    });

    app.get("/overview", async () => overview.overview());

    // Polled by the dashboard, so the balance badge stays live between cycles.
    app.get("/wallet", async () => walletBalance.read());

    app.post<{ Body: { paused: boolean } }>(
      "/opening",
      {
        schema: {
          body: {
            type: "object",
            required: ["paused"],
            properties: { paused: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
      async (req) => ({ status: overview.setOpeningPaused(req.body.paused) }),
    );

    app.get("/stream", (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        // CORS headers set by @fastify/cors live on the reply; hijacking skips them otherwise.
        ...(reply.getHeaders() as Record<string, string>),
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      send(res, "hello", overview.overview());
      clients.add(res);
      const beat = setInterval(() => send(res, "ping", { t: Date.now() }), HEARTBEAT_MS);
      req.raw.on("close", () => {
        clearInterval(beat);
        clients.delete(res);
      });
    });
  };
