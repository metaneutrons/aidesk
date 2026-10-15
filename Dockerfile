# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS development
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca,uid=1000,gid=1000,mode=0400 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.25.0 --strict-ssl=true
ENV pnpm_config_store_dir=/pnpm/store
RUN mkdir -p /pnpm/store /app/.next && chown node:node /app /app/.next /pnpm /pnpm/store
USER node
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node scripts/install-hooks.mjs ./scripts/install-hooks.mjs
RUN --mount=type=secret,id=proxy_ca,uid=1000,gid=1000,mode=0400 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
# Compose bind-mounts the source. Keep the development image dependency-only
# so source edits do not rebuild it or duplicate the dependency layer.
EXPOSE 3000
CMD ["sh", "scripts/boot-dev.sh"]

# The image that runs: the web server, the worker and the migrations are one image with
# three commands. The worker needs the source (it runs it with tsx and builds the reader
# of documents with esbuild when it starts), and the reader runs in a closed process of
# Node's permission model started through /bin/sh, so the base is a full Debian image
# and not a distroless one.
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca,uid=1000,gid=1000,mode=0400 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.25.0 --strict-ssl=true
ENV pnpm_config_store_dir=/pnpm/store
RUN mkdir -p /pnpm/store /app && chown -R node:node /app /pnpm
USER node
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node scripts/install-hooks.mjs ./scripts/install-hooks.mjs
RUN --mount=type=secret,id=proxy_ca,uid=1000,gid=1000,mode=0400 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    AIDESK_SKIP_GIT_HOOKS=true CI=true pnpm install --frozen-lockfile
COPY --chown=node:node . .
RUN NEXT_TELEMETRY_DISABLED=1 pnpm build
# What the process needs is a dependency; the tools of development stay behind.
RUN CI=true pnpm prune --prod

FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS production
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The application files belong to root and are read-only for the process; it writes
# only to the temporary directory.
COPY --from=build /app/package.json /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
# The web server is the standalone build of Next.js: its own files and the dependencies it
# traced, with the static files beside it. The worker and the migrations use the source
# and the dependencies above.
COPY --from=build /app/.next/standalone ./web
COPY --from=build /app/.next/static ./web/.next/static
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=build /app/scripts/smoke.ts ./scripts/smoke.ts
COPY --from=build /app/resources ./resources
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=10s --retries=6 --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# The web server. The worker is `node_modules/.bin/tsx src/worker/index.ts` and the
# migrations are `node_modules/.bin/tsx scripts/migrate.ts`.
CMD ["node", "web/server.js"]
