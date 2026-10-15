FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs `prisma generate` (needs the schema, not a database).
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json prisma.config.ts ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
# data/ only holds old JSON files for `import-legacy`; everything else lives in Postgres.
VOLUME ["/app/data"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js run"]
