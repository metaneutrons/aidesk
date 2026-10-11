#!/bin/sh
set -eu
[ "${NODE_ENV:-}" = development ]
CI=true pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev:seed
exec pnpm dev
