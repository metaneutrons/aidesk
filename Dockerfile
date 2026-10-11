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
