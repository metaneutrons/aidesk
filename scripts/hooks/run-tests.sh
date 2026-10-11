#!/bin/sh
# Test suite for pre-push. CI and explicit host setups supply DATABASE_URL.
# Otherwise the private development stack owns PostgreSQL, which is not
# published to the host, so the tests run inside its app container.
set -eu
if [ -n "${TEST_DATABASE_URL:-}${DATABASE_URL:-}" ]; then
  exec pnpm test --run
fi
if [ ! -f .env.development ] ||
  ! sh scripts/dev.sh ps --status running --services 2>/dev/null | grep -qx app; then
  echo "No DATABASE_URL and the development app container is not running." >&2
  echo "Start it with: sh scripts/dev.sh up -d" >&2
  exit 1
fi
# When the host recreates its node_modules directory, some bind-mount
# implementations detach the container's dependency volume from that path and
# the container would run host-platform binaries. The volume then no longer
# sits on a separate device.
if ! sh scripts/dev.sh exec -T app sh -c \
  '[ "$(stat -c %d /app/node_modules)" != "$(stat -c %d /app)" ]'; then
  echo "The app container no longer sees its dependency volume." >&2
  echo "Recreate it with: sh scripts/dev.sh up -d --force-recreate app worker" >&2
  exit 1
fi
exec sh scripts/dev.sh exec -T app pnpm test --run
