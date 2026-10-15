import type { FastifyPluginAsync } from "fastify";
import type { JournalService } from "../application/journal.service";

export const journalRoutes =
  (journal: JournalService): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { limit: number; type?: string } }>(
      "/journal",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
              type: { type: "string", enum: ["open", "close", "claim", "skip", "halt"] },
            },
          },
        },
      },
      async (req) => ({ entries: await journal.tail(req.query.limit, req.query.type) }),
    );
  };
