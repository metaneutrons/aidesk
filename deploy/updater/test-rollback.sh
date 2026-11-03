#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The updater against real containers: a stack from compose.production.yaml (the bundled database and storage, the web
# server, the worker), updated by update.sh through update_once to
#
#   0.2.0  a good image                        -> installed, backed up, pinned
#   0.3.0  an image whose web server dies      -> put back, nothing pinned
#   0.4.0  an image with a migration that fails -> put back, and what the migration did is undone
#   0.5.0  the same migration without the fault -> installed, and the table it makes is there (the counter-probe of 0.4.0)
#
# The dump that 0.2.0 takes is restored with the commands of docs/updating.md.
#
# Only two things are replaced: the signature check (it needs an image that was signed by the release workflow, which a
# local image is not; the workflow checks it, and test-update.sh tests the way it is called) and the pull (the images are
# local). Everything else is the real worker, the real Compose and the real engine. The images are made from one base
# image with other labels and commands, under a repository of their own, so that nothing of a real installation is
# touched.
#
#   docker build --target production --tag aidesk-production .
#   bash deploy/updater/test-rollback.sh [base-image]
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
base_image="${1:-aidesk-production}"
project="aidesk-rbtest"
repository="aidesk-rbtest/aidesk"
port="${ROLLBACK_TEST_PORT:-39201}"

docker image inspect "$base_image" >/dev/null 2>&1 || {
  printf 'The base image %s is missing: docker build --target production --tag aidesk-production .\n' "$base_image" >&2
  exit 2
}

work="$(mktemp -d)"
mkdir -p "$work/state" "$work/backups"
failures=0

compose() {
  docker compose --env-file "$work/env.production" --project-directory "$work" \
    --project-name "$project" --file "$work/compose.production.yaml" "$@"
}

cleanup() {
  local status=$?
  compose --profile bundled down --volumes --remove-orphans >/dev/null 2>&1 || true
  for tag in 0.1.0 0.2.0 0.3.0 0.4.0 0.5.0 rollback; do
    docker rmi --force "${repository}:${tag}" >/dev/null 2>&1 || true
  done
  rm -rf "${work:?}"
  exit "$status"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
check() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  ok    %s\n' "$description"
  else
    printf '  FAIL  %s\n' "$description"
    failures=$((failures + 1))
  fi
}

# ── The stack ─────────────────────────────────────────────────────────
secret() { openssl rand -hex "$1"; }
cp "$repo_root/compose.production.yaml" "$work/compose.production.yaml"
cat >"$work/env.production" <<EOF
APP_URL=http://127.0.0.1:${port}
APP_PORT=${port}
POSTGRES_PASSWORD=$(secret 16)
S3_ACCESS_KEY=$(secret 8)
S3_SECRET_KEY=$(secret 16)
BETTER_AUTH_SECRET=$(secret 24)
ENCRYPTION_KEY=$(secret 32)
AIDESK_IMAGE=${repository}:0.1.0
EOF
chmod 600 "$work/env.production"

version_image() { # tag, extra lines of the Dockerfile
  printf 'FROM %s\nUSER root\nLABEL org.opencontainers.image.version=%s\n%s\nUSER node\n' \
    "$base_image" "$1" "${2:-}" | docker build --quiet --tag "${repository}:$1" - >/dev/null
}

say "Images"
version_image 0.1.0
version_image 0.2.0
# The web server ends at once; the migrations and the worker have commands of their own and are fine.
version_image 0.3.0 'CMD ["node", "-e", "process.exit(1)"]'
# An image with one more migration: it makes a table, and then does what the second statement says. With `SELECT 1 / 0`
# the migration fails and the whole run of the migrations has to be undone; with `SELECT 1` it is applied.
migration_image() { # tag, the second statement
  local directory="$work/migration-$1"
  mkdir "$directory"
  printf 'CREATE TABLE "rollback_probe" ("id" integer);\n--> statement-breakpoint\n%s;\n' "$2" >"$directory/0999_rollback_probe.sql"
  cat >"$directory/add-entry.mjs" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const path = "/app/drizzle/meta/_journal.json";
const journal = JSON.parse(readFileSync(path, "utf8"));
const last = journal.entries.at(-1);
journal.entries.push({
  idx: last.idx + 1,
  version: "7",
  // Later than every migration that is applied, or the runner skips it.
  when: Math.max(last.when, Date.now()) + 86_400_000,
  tag: "0999_rollback_probe",
  breakpoints: true,
});
writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
JS
  cat >"$directory/Dockerfile" <<EOF
FROM ${base_image}
USER root
COPY 0999_rollback_probe.sql /app/drizzle/0999_rollback_probe.sql
COPY add-entry.mjs /tmp/add-entry.mjs
RUN node /tmp/add-entry.mjs && rm /tmp/add-entry.mjs
LABEL org.opencontainers.image.version=$1
USER node
EOF
  docker build --quiet --tag "${repository}:$1" "$directory" >/dev/null
}
migration_image 0.4.0 'SELECT 1 / 0'
migration_image 0.5.0 'SELECT 1'

say "Start the stack with 0.1.0"
compose --profile bundled up --detach --no-build >/dev/null 2>&1
wait_ready() {
  local deadline=$((SECONDS + ${1:-180}))
  while ((SECONDS < deadline)); do
    curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/api/health/ready" | jq -e '.status == "ready"' >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
check "the stack is ready" wait_ready 240

container() { docker ps --quiet --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.service=$1" | head -n1; }
running_version() {
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "$(docker inspect --format '{{.Image}}' "$(container app)")"
}
worker_running() { [[ "$(docker inspect --format '{{.State.Status}}' "$(container worker)")" == running ]]; }
# The database is asked through its container: its profile is not one that Compose is told about here.
sql() { docker exec "$(container postgres)" psql --username aidesk --dbname aidesk --tuples-only --no-align --command "$1"; }
pin() { sed -n 's/^AIDESK_IMAGE=//p' "$work/env.production"; }
journal() { jq -r "$1" "$work/state/progress.json"; }
check "0.1.0 runs" test "$(running_version)" = 0.1.0

# What the updater does for one release: the real worker, the real Compose, the real engine. It runs with an environment
# of its own (`env -i`), so that nothing of the environment of the person who runs the test, which may hold credentials,
# is inherited, and nothing of it can end up in a log. The body of `bash -c` is single-quoted on purpose: the inner shell
# reads it from that environment. No comment may stand between the lines of the command, or it is cut in two.
# shellcheck disable=SC2016
update_to() { # version, readiness timeout in seconds
  env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} \
    TARGET_VERSION="v$1" READINESS_TIMEOUT_SECONDS="$2" \
    COMPOSE_FILE="$work/compose.production.yaml" STACK_ENV_FILE="$work/env.production" HOST_STACK_DIR="$work" \
    COMPOSE_PROJECT="$project" IMAGE_REPOSITORY="$repository" BACKUP_DIR="$work/backups" \
    PROGRESS_FILE="$work/state/progress.json" ENV_BACKUP_FILE="$work/state/env.backup" \
    READINESS_URL="http://127.0.0.1:${port}/api/health/ready" AUTO_UPDATE_UPDATER=false \
    UPDATE_SH="$here/update.sh" \
    bash -c 'source "$UPDATE_SH"; verify_image() { return 0; }; update_once' >"$work/update.log" 2>&1
}

# ── 0.2.0: a good release ─────────────────────────────────────────────
say "Update to 0.2.0 (good)"
# Something in the database that the backup has to hold.
sql 'create table restore_probe as select 42 as v' >/dev/null
check "the update succeeds" update_to 0.2.0 120
check "0.2.0 runs" test "$(running_version)" = 0.2.0
check "the image is pinned" test "$(pin)" = "${repository}:0.2.0"
check "the journal says done" test "$(journal .phase)" = "done"
dump="$(find "$work/backups" -name 'aidesk-pre-0.2.0-*.dump' | head -n1)"
check "a backup of the database was made" test -s "${dump:-/nonexistent}"
dump_readable() {
  local lines
  lines="$(docker exec -i "$(container postgres)" pg_restore --list <"$dump" | grep -c .)"
  ((lines > 10))
}
check "the backup can be read by pg_restore" dump_readable
check "the web server is ready" wait_ready 60
check "the worker runs" worker_running

# The documented restore of the dump of an update (docs/updating.md): stop the web server and the worker, put the dump
# back with --clean, start them again.
say "Restore the dump of the update"
sql 'drop table restore_probe' >/dev/null
check "the table is gone" test -z "$(sql "select to_regclass('public.restore_probe')" | tr -d '[:space:]')"
compose --profile bundled stop app worker >/dev/null 2>&1
docker exec -i "$(container postgres)" pg_restore --username aidesk --dbname aidesk --clean --if-exists --no-owner <"$dump" >/dev/null 2>&1 || true
compose --profile bundled up --detach --no-build --no-deps app worker >/dev/null 2>&1
check "the web server is ready again" wait_ready 120
check "the table is back with its data" test "$(sql 'select v from restore_probe' | tr -d '[:space:]')" = 42
check "0.2.0 runs after the restore" test "$(running_version)" = 0.2.0
migrations_before="$(sql 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')"

# ── 0.3.0: the web server dies ────────────────────────────────────────
say "Update to 0.3.0 (the web server dies)"
if update_to 0.3.0 45; then
  printf '  FAIL  the update of a broken image was reported as a success\n'
  failures=$((failures + 1))
else
  printf '  ok    the update fails\n'
fi
check "the web server is ready again" wait_ready 120
check "0.2.0 runs again" test "$(running_version)" = 0.2.0
check "the broken image is not pinned" test "$(pin)" = "${repository}:0.2.0"
check "the journal names the step that failed and the rollback" test "$(journal '[.phase, .failedPhase, .rollbackAttempted] | join(",")')" = "failed,waiting-for-health,true"
check "the worker runs" worker_running

# ── 0.4.0: a migration that fails ─────────────────────────────────────
say "Update to 0.4.0 (a migration fails)"
if update_to 0.4.0 60; then
  printf '  FAIL  the update with a failing migration was reported as a success\n'
  failures=$((failures + 1))
else
  printf '  ok    the update fails\n'
fi
check "the web server is ready" wait_ready 120
check "0.2.0 runs" test "$(running_version)" = 0.2.0
check "the image of the failing migration is not pinned" test "$(pin)" = "${repository}:0.2.0"
check "the journal says that the migration step failed and the rollback ran" test "$(journal '[.phase, .failedPhase, .rollbackAttempted] | join(",")')" = "failed,deploying,true"
check "the table that the migration made is not there (the migration is undone as a whole)" test -z "$(sql "select to_regclass('public.rollback_probe')" | tr -d '[:space:]')"
check "the list of applied migrations is the same" test "$(sql 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')" = "$migrations_before"
check "the worker runs" worker_running

# ── 0.5.0: the same migration without the fault ───────────────────────
say "Update to 0.5.0 (the migration is good)"
check "the update succeeds" update_to 0.5.0 120
check "0.5.0 runs" test "$(running_version)" = 0.5.0
check "the image is pinned" test "$(pin)" = "${repository}:0.5.0"
check "the table of the migration is there" test "$(sql "select to_regclass('public.rollback_probe')" | tr -d '[:space:]')" = "rollback_probe"
check "one more migration is applied" test "$(sql 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')" = "$((migrations_before + 1))"
check "the web server is ready" wait_ready 60
check "the worker runs" worker_running

say "Result"
if ((failures > 0)); then
  printf '%d check(s) failed. The log of the last update:\n' "$failures" >&2
  # Only the lines of the updater itself; nothing else of the log is shown.
  grep 'aidesk-updater:' "$work/update.log" | sed 's/^/    /' | tail -30 >&2 || true
  exit 1
fi
printf 'The updater installs a good release and puts the old one back for a web server that dies and for a failing migration; the dump of an update restores.\n'
