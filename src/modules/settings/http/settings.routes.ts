import type { FastifyPluginAsync } from "fastify";
import { SettingsError, type SettingsService } from "../application/settings.service";

export const settingsRoutes =
  (settings: SettingsService, onChange: () => void): FastifyPluginAsync =>
  async (app) => {
    app.get("/settings", async () => settings.view());

    app.put<{ Body: { values: Record<string, unknown> } }>(
      "/settings",
      {
        schema: {
          body: {
            type: "object",
            required: ["values"],
            properties: { values: { type: "object", minProperties: 1, maxProperties: 100 } },
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        try {
          const view = await settings.update(req.body.values);
          onChange();
          return view;
        } catch (e) {
          if (e instanceof SettingsError) return reply.code(400).send({ error: e.message, problems: e.problems });
          throw e;
        }
      },
    );
  };
