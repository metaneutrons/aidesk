#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Tests of update.sh with a replaced `docker`: no daemon, no network.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
update_sh="${here}/update.sh"
test_directory="$(mktemp -d)"
trap 'rm -rf "${test_directory:?}"' EXIT

export UPDATE_ONCE=true
export AUTO_UPDATE_UPDATER=false
export COMPOSE_FILE="${BASH_SOURCE[0]}"
export STACK_ENV_FILE="${test_directory}/env.production"
export ENV_BACKUP_FILE="${test_directory}/state/env.production.backup"
export PROGRESS_FILE="${test_directory}/state/progress.json"
export BACKUP_DIR="${test_directory}/backups"
export HOST_STACK_DIR="$test_directory"
printf '%s\n' \
  'APP_URL=https://desk.example.org' \
  'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.1' \
  'SOME_SETTING=preserved' >"$STACK_ENV_FILE"
# shellcheck source=update.sh
source "$update_sh"

assert() { "$@" >/dev/null || { printf 'FAILED: %q ' "$@" >&2; printf '\n' >&2; exit 1; }; }
refute() { if "$@" >/dev/null 2>&1; then printf 'FAILED (should not hold): %q ' "$@" >&2; printf '\n' >&2; exit 1; fi; }

# ── Compose ───────────────────────────────────────────────────────────
# Compose runs in the updater and controls the daemon of the host: the project directory must
# be the host's, or relative bind sources become /stack/* on the host.
export PROBE="${test_directory}/probe.log"
# Invoked indirectly by compose_stack.
# shellcheck disable=SC2317,SC2329
docker() { printf 'args=%s\n' "$*" >"$PROBE"; }
compose_stack ps updater
assert grep -Fq -- "--project-directory $test_directory" "$PROBE"
assert grep -Fq -- "--env-file $STACK_ENV_FILE" "$PROBE"
assert grep -Fq -- "--project-name aidesk" "$PROBE"
unset -f docker

assert test "$RELEASE_API" = "https://api.github.com/repos/metaneutrons/aidesk/releases/latest"

# Docker makes a directory of a bind source that is missing. That must fail in the preflight,
# before a backup or a deployment. The variables expand in the inner shell.
# shellcheck disable=SC2016
refute env COMPOSE_FILE="$test_directory" STACK_ENV_FILE="$STACK_ENV_FILE" \
  HOST_STACK_DIR="$test_directory" UPDATE_SH="$update_sh" \
  bash -c 'source "$UPDATE_SH"; require_command() { :; }; validate_config' >/dev/null 2>&1

# ── Versions and tags ─────────────────────────────────────────────────
assert version_is_newer v1.8.1 v1.8.2
assert version_is_newer 1.8.9 v1.9.0
assert version_is_newer v1.9.9 v2.0.0
assert version_is_newer 1.9.9 1.10.0
refute version_is_newer v1.8.2 v1.8.2
refute version_is_newer 1.8.2 v1.8.2
refute version_is_newer v2.0.0 v1.9.9

# The tags of the images have no v, the tag of the release has one.
assert test "$(image_ref ghcr.io/metaneutrons/aidesk v1.8.2)" = "ghcr.io/metaneutrons/aidesk:1.8.2"
assert test "$(image_ref ghcr.io/metaneutrons/aidesk-updater 1.8.2)" = "ghcr.io/metaneutrons/aidesk-updater:1.8.2"

# Invoked indirectly by latest_release_tag.
# shellcheck disable=SC2317,SC2329
github_curl() { printf '%s' '[{"tag_name":"v1.8.1","draft":false,"prerelease":false},{"tag_name":"v1.10.0","draft":false,"prerelease":false},{"tag_name":"v1.9.0","draft":false,"prerelease":false},{"tag_name":"v2.0.0","draft":true,"prerelease":false},{"tag_name":"v3.0.0","draft":false,"prerelease":true}]'; }
assert test "$(latest_release_tag)" = "v1.10.0"
# shellcheck disable=SC2317,SC2329
github_curl() { printf '%s' '[{"tag_name":"v2.0.0","draft":true,"prerelease":false}]'; }
refute latest_release_tag
# shellcheck disable=SC2317,SC2329
github_curl() { printf '%s' '{"tag_name":"v1.8.2","draft":false,"prerelease":false}'; }
assert test "$(latest_release_tag)" = "v1.8.2"

# The control API resolves the release once and the worker is given exactly that one.
assert grep -Fq 'TARGET_VERSION: targetVersion' "${here}/control.mjs"

# ── Image pins ────────────────────────────────────────────────────────
# The rewrite is surgical: one key, the others untouched, the old file kept.
persist_env_pin AIDESK_IMAGE 'ghcr.io/metaneutrons/aidesk:1.8.2'
assert grep -Fx 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' "$STACK_ENV_FILE"
assert grep -Fx 'SOME_SETTING=preserved' "$STACK_ENV_FILE"
assert grep -Fx 'APP_URL=https://desk.example.org' "$STACK_ENV_FILE"
assert grep -Fx 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.1' "$ENV_BACKUP_FILE"
assert test "$(grep -c '^AIDESK_IMAGE=' "$STACK_ENV_FILE")" = 1
# A key that is not there yet is added, after a last line that has no newline.
printf 'LAST=line' >"$STACK_ENV_FILE"
persist_env_pin UPDATER_IMAGE 'ghcr.io/metaneutrons/aidesk-updater:1.8.2'
assert grep -Fx 'LAST=line' "$STACK_ENV_FILE"
assert grep -Fx 'UPDATER_IMAGE=ghcr.io/metaneutrons/aidesk-updater:1.8.2' "$STACK_ENV_FILE"
# A key that is there twice is ambiguous: nothing is written.
printf 'AIDESK_IMAGE=a\nAIDESK_IMAGE=b\n' >"$STACK_ENV_FILE"
refute persist_env_pin AIDESK_IMAGE 'ghcr.io/metaneutrons/aidesk:1.8.2'
assert test "$(cat "$STACK_ENV_FILE")" = "$(printf 'AIDESK_IMAGE=a\nAIDESK_IMAGE=b')"
printf '%s\n' 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.1' 'SOME_SETTING=preserved' >"$STACK_ENV_FILE"

# ── Services found by label ───────────────────────────────────────────
# shellcheck disable=SC2317,SC2329
docker() { printf '%s\n' "$*" >"$PROBE"; printf 'abc123\n'; }
assert test "$(service_container_id app)" = "abc123"
assert grep -Fq 'label=com.docker.compose.project=aidesk' "$PROBE"
assert grep -Fq 'label=com.docker.compose.service=app' "$PROBE"
unset -f docker

# ── Backup ────────────────────────────────────────────────────────────
# A bundled database is dumped. Without a container to ask and without BACKUP_ENABLED=false the
# update does not start.
# shellcheck disable=SC2317,SC2329
docker() { return 0; }
refute backup_database 1.8.2
assert test ! -e "$BACKUP_DIR" || test -z "$(ls -A "$BACKUP_DIR")"
BACKUP_ENABLED=false assert backup_database 1.8.2
unset -f docker

# shellcheck disable=SC2317,SC2329
docker() {
  case "$1" in
    ps) printf 'dbcontainer\n' ;;
    exec) printf 'PGDMP-content' ;;
  esac
}
backup_database v1.8.2
dump="$(ls "$BACKUP_DIR"/aidesk-pre-1.8.2-*.dump)"
assert test -s "$dump"
assert test "$(stat -c '%a' "$dump" 2>/dev/null || stat -f '%Lp' "$dump")" = 600
assert jq -e '.phase == "backing-up"' "$PROGRESS_FILE" >/dev/null
# A dump that comes out empty stops the update and leaves no file behind.
rm -f "${BACKUP_DIR:?}"/*
# shellcheck disable=SC2317,SC2329
docker() {
  case "$1" in
    ps) printf 'dbcontainer\n' ;;
    exec) : ;;
  esac
}
refute backup_database v1.8.3
assert test -z "$(ls -A "$BACKUP_DIR")"
# A failing pg_dump too.
# shellcheck disable=SC2317,SC2329
docker() {
  case "$1" in
    ps) printf 'dbcontainer\n' ;;
    exec) return 1 ;;
  esac
}
refute backup_database v1.8.3
assert test -z "$(ls -A "$BACKUP_DIR")"
unset -f docker

printf 'updater shell tests passed\n'

# ── Readiness ─────────────────────────────────────────────────────────
# What the web server answers at /api/health/ready: ready with 200, unavailable with 503. The
# loop is real here, only curl is replaced; the time is cut to one second in a subshell
# because the limit is readonly once update.sh is sourced.
readiness() {
  # shellcheck disable=SC2016
  env READINESS_TIMEOUT_SECONDS=1 UPDATE_SH="$update_sh" ANSWER="$1" CURL_FAILS="${2:-0}" \
    COMPOSE_FILE="$COMPOSE_FILE" STACK_ENV_FILE="$STACK_ENV_FILE" HOST_STACK_DIR="$test_directory" \
    PROGRESS_FILE="$PROGRESS_FILE" \
    bash -c '
    source "$UPDATE_SH"
    curl() { [[ "$CURL_FAILS" == "1" ]] && return 22; printf "%s" "$ANSWER"; }
    wait_for_readiness false
  ' >/dev/null 2>&1
}
assert readiness '{"status":"ready"}'
refute readiness '{"status":"unavailable"}'
refute readiness '{"status":"ok"}'
refute readiness 'not json'
refute readiness '{"status":"ready"}' 1

# ── Deployment and rollback ───────────────────────────────────────────
# The migrations run first and must end well before the containers are replaced.
export CALLS="${test_directory}/calls.log"
: >"$CALLS"
# shellcheck disable=SC2317,SC2329
docker() {
  case "$1" in
    ps) printf 'appcontainer\n' ;;
    inspect) printf 'sha256:old\n' ;;
    image) return 0 ;;
    compose) printf 'AIDESK_IMAGE=%s %s\n' "${AIDESK_IMAGE:-}" "$*" >>"$CALLS"
             [[ "${FAIL_MIGRATE:-}" == "1" && "$*" == *" run "* && "${AIDESK_IMAGE:-}" == *":bad" ]] && return 1
             return 0 ;;
  esac
}
FAIL_MIGRATE=1 refute compose_deploy ghcr.io/metaneutrons/aidesk:bad
assert grep -Fq ' run --rm --no-deps -T migrate' "$CALLS"
refute grep -Fq ' up ' "$CALLS"
: >"$CALLS"
assert compose_deploy ghcr.io/metaneutrons/aidesk:1.8.2
assert test "$(grep -n ' run ' "$CALLS" | head -1 | cut -d: -f1)" -lt "$(grep -n ' up ' "$CALLS" | head -1 | cut -d: -f1)"
assert grep -Fq 'up --detach --no-deps --no-build --pull never --force-recreate app worker' "$CALLS"
assert grep -Fq 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2 ' "$CALLS"
# The database and the storage are never named.
refute grep -E 'postgres|storage' "$CALLS"

# Healthy: the pin is written and the journal ends in `done`.
# shellcheck disable=SC2317,SC2329
wait_for_readiness() { return 0; }
export PHASE_STARTED_AT="2026-08-13T00:00:00Z"
assert deploy_with_rollback ghcr.io/metaneutrons/aidesk:1.8.2
assert grep -Fx 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' "$STACK_ENV_FILE"
assert jq -e '.phase == "done"' "$PROGRESS_FILE" >/dev/null

# Not ready: the old image goes back, the pin stays, the journal says what failed.
printf '%s\n' 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' >"$STACK_ENV_FILE"
: >"$CALLS"
# shellcheck disable=SC2317,SC2329
wait_for_readiness() { [[ "${1:-true}" == "true" ]] && set_phase "waiting-for-health"; [[ "${1:-true}" == "false" ]]; }
refute deploy_with_rollback ghcr.io/metaneutrons/aidesk:1.8.3
assert grep -Fq 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.3 ' "$CALLS"
assert grep -Fq 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:rollback ' "$CALLS"
assert grep -Fx 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' "$STACK_ENV_FILE"
assert jq -e '.phase == "failed" and .rollbackAttempted == true and .failedPhase == "waiting-for-health"' "$PROGRESS_FILE" >/dev/null

# The rollback fails as well: the journal asks for the operator.
# shellcheck disable=SC2317,SC2329
wait_for_readiness() { return 1; }
refute deploy_with_rollback ghcr.io/metaneutrons/aidesk:1.8.4
assert jq -e '.phase == "failed" and (.detail | contains("operator intervention"))' "$PROGRESS_FILE" >/dev/null
unset -f docker wait_for_readiness

printf 'deployment and rollback assertions passed\n'

# ── Updater self-update ───────────────────────────────────────────────
# The pin of the updater image is a surgical rewrite as well.
printf '%s\n' 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' 'SOME_SETTING=preserved' >"$STACK_ENV_FILE"
assert persist_env_pin UPDATER_IMAGE 'ghcr.io/metaneutrons/aidesk-updater:1.8.2'
assert grep -Fqx 'UPDATER_IMAGE=ghcr.io/metaneutrons/aidesk-updater:1.8.2' "$STACK_ENV_FILE"
assert grep -Fqx 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:1.8.2' "$STACK_ENV_FILE"
assert grep -Fqx 'SOME_SETTING=preserved' "$STACK_ENV_FILE"

# Switched off by policy: an update of the product does not swap the updater.
assert test "$AUTO_UPDATE_UPDATER" = "false"
assert schedule_updater_swap v1.9.0

swap_probe() {
  # `env` rather than a prefix: the flag is readonly in this shell once update.sh is sourced.
  # The body is single-quoted on purpose, those variables expand in the inner shell.
  # shellcheck disable=SC2016
  env AUTO_UPDATE_UPDATER=true UPDATER_VERSION="$1" UPDATE_ONCE=true \
    COMPOSE_FILE="$COMPOSE_FILE" STACK_ENV_FILE="$STACK_ENV_FILE" \
    HOST_STACK_DIR="$test_directory" \
    ENV_BACKUP_FILE="$ENV_BACKUP_FILE" SWAP_RESULT_FILE="${test_directory}/state/swap.json" \
    PROBE_LOG="$PROBE_LOG" UPDATE_SH="$update_sh" \
    bash -c '
    source "$UPDATE_SH"
    verify_image() { printf "%s %s\n" "$1" "$2" >>"$PROBE_LOG.verify"; return 0; }
    service_container_id() { printf "self-id"; }
    docker() {
      case "$1" in
        inspect) printf "ghcr.io/metaneutrons/aidesk-updater:%s\n" "${UPDATER_VERSION#v}" ;;
        run) printf "%s\n" "$*" >>"$PROBE_LOG" ;;
      esac
    }
    schedule_updater_swap "$1" || true
  ' _ "$2"
}

export PROBE_LOG="${test_directory}/swap-probe.log"
: >"$PROBE_LOG"
swap_result="${test_directory}/state/swap.json"
mkdir -p "$(dirname "$swap_result")"
printf '%s\n' '{"outcome":"rolled-back","detail":"stale","at":null}' >"$swap_result"

# Behind the release: a detached helper for the right candidate, after the signature was checked.
swap_probe 1.8.1 v1.8.2
assert test ! -e "$swap_result"
assert grep -q -- '--swap-updater ghcr.io/metaneutrons/aidesk-updater:1.8.2' "$PROBE_LOG"
assert grep -Fxq 'ghcr.io/metaneutrons/aidesk-updater:1.8.2 ghcr.io/metaneutrons/aidesk-updater' "$PROBE_LOG.verify"
# It takes over the mounts instead of passing container paths as host paths.
assert grep -q -- '--volumes-from self-id' "$PROBE_LOG"
# It has no network while it swaps.
assert grep -q -- '--network none' "$PROBE_LOG"
assert grep -q -- "--env HOST_STACK_DIR=$test_directory" "$PROBE_LOG"
assert grep -q -- "--env STACK_ENV_FILE=$STACK_ENV_FILE" "$PROBE_LOG"
assert grep -q -- '--entrypoint /usr/local/bin/aidesk-update' "$PROBE_LOG"

# Already current, and newer than the release: no helper.
: >"$PROBE_LOG"
swap_probe 1.8.2 v1.8.2
swap_probe 1.9.9 v1.8.2
refute test -s "$PROBE_LOG"

# A helper that cannot be started is a result the page can show instead of an overlay that
# spins on.
# shellcheck disable=SC2016
env AUTO_UPDATE_UPDATER=true UPDATER_VERSION=1.8.1 UPDATE_ONCE=true \
  COMPOSE_FILE="$COMPOSE_FILE" STACK_ENV_FILE="$STACK_ENV_FILE" \
  HOST_STACK_DIR="$test_directory" ENV_BACKUP_FILE="$ENV_BACKUP_FILE" \
  SWAP_RESULT_FILE="$swap_result" UPDATE_SH="$update_sh" \
  bash -c '
    source "$UPDATE_SH"
    verify_image() { return 0; }
    service_container_id() { printf "self-id"; }
    docker() {
      [[ "$1" == "inspect" ]] && printf "ghcr.io/metaneutrons/aidesk-updater:1.8.1\n"
      [[ "$1" != "run" ]]
    }
    if schedule_updater_swap v1.8.2; then exit 1; fi
  '
assert jq -e '.outcome == "failed" and (.detail | contains("detached updater swap helper"))' \
  "$swap_result" >/dev/null

# An image whose signature does not hold is never handed to a helper.
: >"$PROBE_LOG"
# shellcheck disable=SC2016
env AUTO_UPDATE_UPDATER=true UPDATER_VERSION=1.8.1 UPDATE_ONCE=true \
  COMPOSE_FILE="$COMPOSE_FILE" STACK_ENV_FILE="$STACK_ENV_FILE" \
  HOST_STACK_DIR="$test_directory" ENV_BACKUP_FILE="$ENV_BACKUP_FILE" \
  SWAP_RESULT_FILE="$swap_result" UPDATE_SH="$update_sh" PROBE_LOG="$PROBE_LOG" \
  bash -c '
    source "$UPDATE_SH"
    verify_image() { return 1; }
    service_container_id() { printf "self-id"; }
    docker() { [[ "$1" == "run" ]] && printf "%s\n" "$*" >>"$PROBE_LOG"; return 0; }
    if schedule_updater_swap v1.8.2; then exit 1; fi
  '
refute test -s "$PROBE_LOG"
assert jq -e '.outcome == "failed" and (.detail | contains("signature verification"))' \
  "$swap_result" >/dev/null

printf 'updater self-update assertions passed\n'

# ── Phase journal ─────────────────────────────────────────────────────
# The product cannot narrate its own restart, so the journal is the only progress the page can
# show. Its shape is fixed here.
export PHASE_STARTED_AT="2026-08-13T00:00:00Z"
set_phase "deploying" "ghcr.io/metaneutrons/aidesk:1.8.2"
assert jq -e '.phase == "deploying"' "$PROGRESS_FILE" >/dev/null
assert jq -e '.detail == "ghcr.io/metaneutrons/aidesk:1.8.2"' "$PROGRESS_FILE" >/dev/null
# startedAt survives the phases, so the page can show the elapsed time.
assert jq -e '.startedAt == "2026-08-13T00:00:00Z"' "$PROGRESS_FILE" >/dev/null
set_phase "done"
assert jq -e '.phase == "done" and .detail == null' "$PROGRESS_FILE" >/dev/null

# The step that failed stays known while the rollback goes on.
set_phase "verifying"
set_phase "backing-up"
set_phase "deploying"
set_phase "rolling-back" "rollback image"
assert jq -e '.phase == "rolling-back" and .failedPhase == "deploying" and .rollbackAttempted == true' "$PROGRESS_FILE" >/dev/null
set_phase "failed" "new release was rolled back"
assert jq -e '.phase == "failed" and .failedPhase == "deploying" and .rollbackAttempted == true' "$PROGRESS_FILE" >/dev/null

# Writing the journal must never abort an update, even where it cannot be written. In a
# subshell: PROGRESS_FILE is readonly once update.sh is sourced.
# shellcheck disable=SC2016
assert env PROGRESS_FILE=/proc/nonexistent/progress.json UPDATE_SH="$update_sh" \
  bash -c 'source "$UPDATE_SH"; set_phase "verifying"' >/dev/null 2>&1

printf 'phase journal assertions passed\n'
