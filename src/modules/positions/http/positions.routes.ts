import type { FastifyPluginAsync } from "fastify";
import type { BotSession } from "../../bot/application/bot-session";
import type { ClosePosition } from "../application/close-position.use-case";
import type { OnchainPositions } from "../application/onchain-positions.use-case";
import type { PositionChart } from "../application/position-chart.use-case";
import type { PositionIl } from "../application/position-il.use-case";
import type { PositionRepository } from "../domain/position.repository";

export const positionsRoutes =
  (
    session: BotSession,
    positions: PositionRepository,
    closePosition: ClosePosition,
    onchain: OnchainPositions,
    positionIl: PositionIl,
    positionChart: PositionChart,
  ): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { closedLimit: number } }>(
      "/positions",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { closedLimit: { type: "integer", minimum: 0, maximum: 500, default: 50 } },
          },
        },
      },
      async (req) => ({
        open: session.positions,
        closed: req.query.closedLimit > 0 ? await positions.recentClosed(req.query.closedLimit) : [],
      }),
    );

    // Real DLMM positions in the wallet, read-only; includes ones opened by hand.
    app.get("/positions/onchain", async () => ({ positions: await onchain.execute() }));

    // Live impermanent loss for the bot's open positions, polled by the dashboard.
    app.get("/positions/il", async () => positionIl.execute());

    // Price vs bin history and the Modul 4 IL simulation for one open position.
    app.get<{ Params: { pubkey: string } }>(
      "/positions/:pubkey/chart",
      {
        schema: {
          params: {
            type: "object",
            required: ["pubkey"],
            properties: { pubkey: { type: "string", minLength: 1, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        const chart = await positionChart.execute(req.params.pubkey);
        if (!chart) return reply.code(404).send({ error: "Posisi tidak ada atau sudah ditutup." });
        return chart;
      },
    );

    // Waits for a running cycle to finish first, so the response can take a while.
    app.post<{ Params: { pubkey: string } }>(
      "/positions/:pubkey/close",
      {
        schema: {
          params: {
            type: "object",
            required: ["pubkey"],
            properties: { pubkey: { type: "string", minLength: 1, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        const r = await closePosition.execute(req.params.pubkey);
        if (r.outcome === "not-found") return reply.code(404).send({ error: "Posisi tidak ada atau sudah ditutup." });
        if (r.outcome === "failed") {
          return reply.code(502).send({ error: "Transaksi close gagal. Posisi masih terbuka, coba lagi." });
        }
        return { closed: true, realizedSol: r.realizedSol };
      },
    );
  };
