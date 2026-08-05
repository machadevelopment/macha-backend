# syntax=docker/dockerfile:1.7
# Portable image for Railway (or any OCI runtime). Bun only — no Node.
FROM oven/bun:1 AS base
WORKDIR /app

# `--ignore-scripts` en los dos `bun install`: sin él la imagen NO compila. `prepare` de
# package.json es `husky`, que es devDependency — con `--production` no se instala y el
# install muere con `husky: command not found` (exit 127). En la etapa `build` husky sí
# está, pero tampoco tiene nada que hacer: el contexto de Docker no incluye `.git`
# (.dockerignore), y los hooks son de la máquina de quien desarrolla, no de la imagen.
# Ninguna dependencia de runtime necesita postinstall, así que saltarse los scripts no
# quita nada. Es la vía que documenta husky para contenedores.

# ---- deps: production-only node_modules for the runtime stage ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---- build: full deps to bundle the app entrypoint ----
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
# CU-868kfvar3: pg_dump for the nightly backup job (db-backup worker) — oven/bun:1
# is Debian-based, postgresql-client is whatever major version bookworm ships. Verify
# it's compatible with Railway's managed Postgres major version; pg_dump works against
# older servers but not newer ones.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json drizzle.config.ts ./
COPY src ./src
EXPOSE 3001
CMD ["bun", "run", "start"]
