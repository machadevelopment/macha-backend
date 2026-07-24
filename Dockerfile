# syntax=docker/dockerfile:1.7
# Portable image for Railway (or any OCI runtime). Bun only — no Node.
FROM oven/bun:1 AS base
WORKDIR /app

# ---- deps: production-only node_modules for the runtime stage ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- build: full deps to bundle the app entrypoint ----
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json drizzle.config.ts ./
COPY src ./src
EXPOSE 3001
CMD ["bun", "run", "start"]
