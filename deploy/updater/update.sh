#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The worker of the updater: checks a release, verifies the signed image, backs up the
# database, replaces the containers of the product and puts the old image back if the new
# one does not become ready. The control API (control.mjs) starts it for one update.

set -Eeuo pipefail

readonly RELEASE_API="${RELEASE_API:-https://api.github.com/repos/metaneutrons/aidesk/releases/latest}"
readonly TARGET_VERSION="${TARGET_VERSION:-}"
readonly IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/metaneutrons/aidesk}"
readonly UPDATER_IMAGE_REPOSITORY="${UPDATER_IMAGE_REPOSITORY:-ghcr.io/metaneutrons/aidesk-updater}"
readonly COMPOSE_FILE="${COMPOSE_FILE:-/stack/compose.production.yaml}"
# The environment file of the installation (passed to Compose with --env-file). The updater
# writes the two image pins into it, so it is mounted writable.
readonly STACK_ENV_FILE="${STACK_ENV_FILE:-/stack/env.production}"
HOST_STACK_DIR="${HOST_STACK_DIR:-}"
readonly ENV_BACKUP_FILE="${ENV_BACKUP_FILE:-/state/env.production.backup}"
readonly COMPOSE_PROJECT="${COMPOSE_PROJECT:-aidesk}"
# Services replaced by an update. The migrations run first, once, then the two long-running ones.
readonly MIGRATE_SERVICE="${MIGRATE_SERVICE:-migrate}"
readonly APP_SERVICE="${APP_SERVICE:-app}"
readonly WORKER_SERVICE="${WORKER_SERVICE:-worker}"
readonly DATABASE_SERVICE="${DATABASE_SERVICE:-postgres}"
readonly UPDATER_SERVICE="${UPDATER_SERVICE:-updater}"
readonly DATABASE_USER="${POSTGRES_USER:-aidesk}"
readonly DATABASE_NAME="${POSTGRES_DB:-aidesk}"
readonly BACKUP_DIR="${BACKUP_DIR:-/backups}"
readonly BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
readonly POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-3600}"
readonly READINESS_URL="${READINESS_URL:-http://app:3000/api/health/ready}"
readonly READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-120}"
# Both images are built and signed by the same workflow, on the tag of a release.
readonly COSIGN_ISSUER="https://token.actions.githubusercontent.com"
readonly COSIGN_IDENTITY_REGEXP='^https://github\.com/metaneutrons/aidesk/\.github/workflows/release-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
# A detached helper replaces the updater, checks it and puts the old one back if it fails.
readonly AUTO_UPDATE_UPDATER="${AUTO_UPDATE_UPDATER:-true}"
readonly UPDATER_SWAP_TIMEOUT_SECONDS="${UPDATER_SWAP_TIMEOUT_SECONDS:-180}"
# The result of a swap outlives the container that did it, so the new updater can report it.
readonly SWAP_RESULT_FILE="${SWAP_RESULT_FILE:-/state/updater-swap.json}"
# The product cannot report its own restart, so each step is written down here and the
# control API hands it to the settings page.
readonly PROGRESS_FILE="${PROGRESS_FILE:-/state/updater-progress.json}"
CURRENT_PHASE=""
FAILED_PHASE=""
ROLLBACK_ATTEMPTED=false

log() {
  printf '%s aidesk-updater: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_config() {
  for command in curl jq docker cosign; do
    require_command "$command"
  done
  # `-r` accepts directories, and Docker creates a directory when the source of a bind mount
  # is missing. That would pass here and fail only after the backup.
  [[ -f "$COMPOSE_FILE" && -r "$COMPOSE_FILE" ]] ||
    die "compose file is not a readable regular file: $COMPOSE_FILE"
  [[ -f "$STACK_ENV_FILE" && -r "$STACK_ENV_FILE" ]] ||
    die "environment file is not a readable regular file: $STACK_ENV_FILE"
  [[ -w "$STACK_ENV_FILE" ]] || die "environment file is not writable: $STACK_ENV_FILE"
  HOST_STACK_DIR="$(resolve_host_stack_dir)" || return 1
  [[ "$POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || die "POLL_INTERVAL_SECONDS must be numeric"
  (( POLL_INTERVAL_SECONDS >= 300 )) || die "POLL_INTERVAL_SECONDS must be at least 300"
  [[ "$READINESS_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "READINESS_TIMEOUT_SECONDS must be numeric"
  (( READINESS_TIMEOUT_SECONDS >= 30 )) || die "READINESS_TIMEOUT_SECONDS must be at least 30"
  [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be numeric"
}

# Compose resolves relative bind sources on the host of the Docker daemon, not inside this
# container. The directory is taken from where the compose file is mounted from.
resolve_host_stack_dir() {
  local source
  if [[ -n "$HOST_STACK_DIR" ]]; then
    [[ "$HOST_STACK_DIR" == /* ]] || {
      die "HOST_STACK_DIR must be an absolute host path"
      return 1
    }
    printf '%s\n' "$HOST_STACK_DIR"
    return 0
  fi

  source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$COMPOSE_FILE"'"}}{{.Source}}{{end}}{{end}}' \
    "${HOSTNAME:-}" 2>/dev/null || true)"
  [[ -n "$source" && "$source" == /* ]] || {
    die "could not determine the host stack directory"
    return 1
  }
  dirname "$source"
}

compose_stack() {
  local host_stack_dir="$HOST_STACK_DIR"
  [[ -n "$host_stack_dir" && "$host_stack_dir" == /* ]] || {
    die "host stack directory is unavailable"
    return 1
  }
  HOST_STACK_DIR="$host_stack_dir" docker compose \
    --env-file "$STACK_ENV_FILE" \
    --project-directory "$host_stack_dir" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" "$@"
}

# The container of a service, found by the labels Compose sets. `compose ps` would not list
# a service of a profile that is not active in this process, and the profiles of the
# installation are not known here.
service_container_id() {
  docker ps --quiet \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=${1}" | head -n1
}

github_curl() {
  local -a headers=(
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
    -H "User-Agent: aidesk-updater"
  )
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  curl --fail --silent --show-error --location --max-time 30 \
    --retry 3 --retry-all-errors --retry-delay 1 --retry-max-time 25 \
    "${headers[@]}" "$@"
}

# A release is published only after its images are signed and checked (release-image.yml),
# so the latest release is one whose images exist.
latest_release_tag() {
  local releases tag
  releases="$(github_curl "$RELEASE_API")" || return 1
  tag="$(jq -er '
    (if type == "array" then . else [.] end)
    | map(select(
        .draft == false
        and .prerelease == false
        and (.tag_name | type == "string" and test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
      ))
    | sort_by(.tag_name | ltrimstr("v") | split(".") | map(tonumber))
    | last
    | .tag_name
  ' <<<"$releases")" || {
    die "GitHub Releases contains no stable release"
    return 1
  }
  printf '%s\n' "$tag"
}

# The tags of the images carry no `v` (docker/metadata-action), the tag of the release does.
image_ref() {
  printf '%s:%s\n' "$1" "${2#v}"
}

# The version of the image the product runs from, empty for an image built on this machine.
current_version() {
  local container image_id
  container="$(service_container_id "$APP_SERVICE")"
  [[ -n "$container" ]] || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || return 1
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "$image_id" 2>/dev/null
}

version_is_newer() {
  local current="${1#v}" candidate="${2#v}"
  [[ "$current" != "$candidate" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$current" "$candidate" | sort -V | tail -n1)" == "$candidate" ]]
}

verify_image() {
  local candidate="$1" repository="${2:-$IMAGE_REPOSITORY}" digest
  if ! docker pull --quiet "$candidate" >/dev/null; then
    die "signed release image is not available: $candidate"
    return 1
  fi
  if ! digest="$(docker image inspect --format '{{ json .RepoDigests }}' "$candidate" |
      jq -er --arg prefix "${repository}@sha256:" 'map(select(startswith($prefix))) | first')"; then
    die "pulled image has no trusted digest for $repository"
    return 1
  fi
  [[ "$digest" == "${repository}@sha256:"* ]] ||
    { die "pulled image has unexpected digest identity: $digest"; return 1; }

  log "verifying Sigstore identity for $digest"
  if ! cosign verify \
    --certificate-oidc-issuer "$COSIGN_ISSUER" \
    --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
    "$digest" >/dev/null; then
    die "image signature or publishing identity is invalid: $candidate"
    return 1
  fi
}

# The dump of the database that comes with the installation (profile `bundled`). With a
# database of your own there is no container to ask: back it up yourself and say so with
# BACKUP_ENABLED=false, or the update does not start.
backup_database() {
  local database destination temporary
  if [[ "${BACKUP_ENABLED:-true}" != "true" ]]; then
    log "database backup is switched off (BACKUP_ENABLED=false)"
    return 0
  fi
  database="$(service_container_id "$DATABASE_SERVICE")"
  [[ -n "$database" ]] ||
    { die "no bundled database is running; set BACKUP_ENABLED=false if you back up your own"; return 1; }

  mkdir -p "$BACKUP_DIR"
  destination="${BACKUP_DIR}/aidesk-pre-${1#v}-$(date -u +'%Y%m%dT%H%M%SZ').dump"
  temporary="${destination}.tmp"

  set_phase "backing-up"
  log "creating pre-update database backup"
  if ! (umask 077 && docker exec "$database" pg_dump \
      --username "$DATABASE_USER" --dbname "$DATABASE_NAME" --format custom >"$temporary"); then
    rm -f "$temporary"
    die "database backup failed; update aborted"
    return 1
  fi
  [[ -s "$temporary" ]] || {
    rm -f "$temporary"
    die "database backup is empty; update aborted"
    return 1
  }
  mv "$temporary" "$destination"
  find "$BACKUP_DIR" -type f -name 'aidesk-pre-*.dump' \
    -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  log "database backup stored at $destination"
}

# Migrations first, in a container of their own that has to end well, then the web server and
# the worker from the same image. The database and the storage are not touched.
compose_deploy() {
  local image="$1"
  AIDESK_IMAGE="$image" compose_stack run --rm --no-deps -T "$MIGRATE_SERVICE" || return 1
  AIDESK_IMAGE="$image" compose_stack \
    up --detach --no-deps --no-build --pull never --force-recreate "$APP_SERVICE" "$WORKER_SERVICE"
}

# Set exactly one KEY=value line in the environment file (added when it is not there),
# keeping a restorable copy first. Used for the pin of the product image and of the updater
# image: without it a later `docker compose up` would bring the old image back.
persist_env_pin() {
  local key="$1" value="$2" count temporary backup_temporary
  count="$(grep -c "^${key}=" "$STACK_ENV_FILE" || true)"
  [[ "$count" == "0" || "$count" == "1" ]] || {
    die "environment file must not contain more than one ${key} setting"
    return 1
  }

  mkdir -p "$(dirname "$ENV_BACKUP_FILE")"
  temporary="$(mktemp)"
  backup_temporary="${ENV_BACKUP_FILE}.tmp"
  if [[ "$count" == "1" ]]; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$STACK_ENV_FILE" >"$temporary"
  else
    { cat "$STACK_ENV_FILE"; [[ -z "$(tail -c1 "$STACK_ENV_FILE")" ]] || printf '\n'; printf '%s=%s\n' "$key" "$value"; } >"$temporary"
  fi
  (umask 077 && cp -p "$STACK_ENV_FILE" "$backup_temporary")
  mv -f "$backup_temporary" "$ENV_BACKUP_FILE"

  # Written in place (not renamed over): the file is a bind mount, and a new file would not
  # be the one the host sees.
  if ! cp "$temporary" "$STACK_ENV_FILE" ||
      ! grep -Fx "${key}=${value}" "$STACK_ENV_FILE" >/dev/null; then
    cp "$ENV_BACKUP_FILE" "$STACK_ENV_FILE" || true
    rm -f "$temporary"
    die "could not persist ${key}"
    return 1
  fi
  rm -f "$temporary"
  sync -f "$STACK_ENV_FILE" 2>/dev/null || true
  log "persisted image pin: ${key}=${value}"
}

wait_for_readiness() {
  local publish_phase="${1:-true}"
  local deadline=$((SECONDS + READINESS_TIMEOUT_SECONDS))
  [[ "$publish_phase" == "true" ]] && set_phase "waiting-for-health"
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 5 "$READINESS_URL" |
        jq -e '.status == "ready"' >/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

deploy_with_rollback() {
  local candidate="$1" container old_id rollback_ref
  container="$(service_container_id "$APP_SERVICE")"
  [[ -n "$container" ]] || { die "the web server is not running; nothing to roll back to"; return 1; }
  old_id="$(docker inspect --format '{{.Image}}' "$container")"
  rollback_ref="${IMAGE_REPOSITORY}:rollback"
  docker image tag "$old_id" "$rollback_ref"

  set_phase "deploying" "$candidate"
  log "deploying $candidate"
  if compose_deploy "$candidate" && wait_for_readiness true; then
    if persist_env_pin AIDESK_IMAGE "$candidate"; then
      log "deployment healthy: $candidate"
      set_phase "done" "$candidate"
      return 0
    fi
    log "deployment healthy but image pin persistence failed; rolling back"
  fi

  log "deployment failed; rolling back to $old_id"
  set_phase "rolling-back" "$rollback_ref"
  if ! compose_deploy "$rollback_ref" || ! wait_for_readiness false; then
    set_phase "failed" "automatic rollback failed; operator intervention required" "rolling-back"
    die "automatic rollback failed; operator intervention required"
    return 1
  fi
  set_phase "failed" "rolled back because the new release did not become ready"
  die "deployment rolled back because the new release did not become ready"
}

# ── Updater self-update ───────────────────────────────────────────────
#
# The updater must not recreate its own container: `compose up` would end the process that
# issues it and leave the swap half done. The running, known-good updater verifies the
# candidate and hands the swap to a detached one-shot container, which survives its parent
# being replaced. The helper runs from the CURRENT image on purpose: a broken new image could
# not roll anything back.

# Advisory like record_swap_result: a failed journal write must not abort an update.
# `phase` is the step now running.
set_phase() {
  local phase="$1" detail="${2:-}" explicit_failed_phase="${3:-}" temporary="${PROGRESS_FILE}.tmp"
  if [[ "$phase" == "verifying" ]]; then
    FAILED_PHASE=""
    ROLLBACK_ATTEMPTED=false
  elif [[ "$phase" == "rolling-back" ]]; then
    [[ -n "$FAILED_PHASE" ]] || FAILED_PHASE="$CURRENT_PHASE"
    ROLLBACK_ATTEMPTED=true
  elif [[ "$phase" == "failed" ]]; then
    if [[ -n "$explicit_failed_phase" ]]; then
      FAILED_PHASE="$explicit_failed_phase"
    elif [[ -z "$FAILED_PHASE" ]]; then
      FAILED_PHASE="$CURRENT_PHASE"
    fi
  fi
  CURRENT_PHASE="$phase"
  log "phase: $phase${detail:+ ($detail)}"
  mkdir -p "$(dirname "$PROGRESS_FILE")" 2>/dev/null || true
  if jq -n --arg phase "$phase" --arg detail "$detail" \
           --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
           --arg started "${PHASE_STARTED_AT:-}" \
           --arg failedPhase "$FAILED_PHASE" \
           --argjson rollbackAttempted "$ROLLBACK_ATTEMPTED" \
           '{phase: $phase, detail: (if $detail == "" then null else $detail end),
             at: $at, startedAt: (if $started == "" then $at else $started end),
             failedPhase: (if $failedPhase == "" then null else $failedPhase end),
             rollbackAttempted: $rollbackAttempted}' \
       >"$temporary" 2>/dev/null; then
    mv -f "$temporary" "$PROGRESS_FILE" 2>/dev/null || rm -f "$temporary" 2>/dev/null || true
  else
    rm -f "$temporary" 2>/dev/null || true
  fi
}

# Recording the outcome must not abort a swap, so every step is advisory.
record_swap_result() {
  local outcome="$1" detail="$2" temporary="${SWAP_RESULT_FILE}.tmp"
  mkdir -p "$(dirname "$SWAP_RESULT_FILE")" 2>/dev/null || true
  if jq -n --arg outcome "$outcome" --arg detail "$detail" \
           --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
           '{outcome: $outcome, detail: $detail, at: $at}' \
       >"$temporary" 2>/dev/null; then
    mv -f "$temporary" "$SWAP_RESULT_FILE" 2>/dev/null || rm -f "$temporary" 2>/dev/null || true
  else
    rm -f "$temporary" 2>/dev/null || true
  fi
}

# The result of a swap describes one attempt only.
clear_swap_result() {
  rm -f "$SWAP_RESULT_FILE" 2>/dev/null || true
}

wait_for_container_health() {
  local container="$1" deadline=$((SECONDS + UPDATER_SWAP_TIMEOUT_SECONDS)) state health
  while (( SECONDS < deadline )); do
    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      return 0
    fi
    [[ "$state" == "exited" || "$state" == "dead" ]] && return 1
    sleep 3
  done
  return 1
}

# The profile is named here: the updater is in the project only when `updater` is active, and
# this process does not know the profiles of the installation.
compose_up_updater() {
  local image="$1"
  UPDATER_IMAGE="$image" compose_stack --profile updater \
    up --detach --no-deps --pull never --force-recreate "$UPDATER_SERVICE"
}

# Runs INSIDE the one-shot helper. Owns the rollback: if the new updater does not come up
# healthy, nothing else is left that could undo the swap.
swap_updater() {
  local candidate="$1" previous_image previous_id new_id
  previous_id="$(service_container_id "$UPDATER_SERVICE")"
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_id" 2>/dev/null || true)"
  [[ -n "$previous_image" ]] || {
    record_swap_result failed "could not determine the running updater image"
    die "could not determine the running updater image"
    return 1
  }

  log "swapping updater: $previous_image -> $candidate"
  if compose_up_updater "$candidate"; then
    new_id="$(service_container_id "$UPDATER_SERVICE")"
    if [[ -n "$new_id" ]] && wait_for_container_health "$new_id"; then
      if persist_env_pin UPDATER_IMAGE "$candidate"; then
        log "updater swap healthy: $candidate"
        record_swap_result succeeded "$candidate"
        return 0
      fi
      log "updater came up healthy but the pin could not be persisted; rolling back"
    else
      log "replacement updater did not become healthy; rolling back"
    fi
  else
    log "could not start the replacement updater; rolling back"
  fi

  if compose_up_updater "$previous_image" && wait_for_container_health "$(service_container_id "$UPDATER_SERVICE")"; then
    record_swap_result "rolled-back" "restored $previous_image"
    die "updater swap rolled back to $previous_image"
    return 1
  fi
  record_swap_result failed "rollback to $previous_image failed; operator intervention required"
  die "updater rollback failed; operator intervention required"
  return 1
}

# Runs in the ORIGINAL updater, after a healthy update of the product.
schedule_updater_swap() {
  local tag="$1" candidate self_id self_image
  [[ "$AUTO_UPDATE_UPDATER" == "true" ]] || return 0

  candidate="$(image_ref "$UPDATER_IMAGE_REPOSITORY" "$tag")"
  if [[ "${UPDATER_VERSION#v}" == "${tag#v}" ]]; then
    return 0
  fi
  if [[ "${UPDATER_VERSION:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
      ! version_is_newer "$UPDATER_VERSION" "$tag"; then
    return 0
  fi

  # A previous result belongs to the previous attempt; left in place it would fail a new,
  # still running update before the helper has published its own result.
  clear_swap_result

  # Verified here, in the known-good container, so a helper is never started for an image
  # that failed its signature check.
  if ! verify_image "$candidate" "$UPDATER_IMAGE_REPOSITORY"; then
    log "updater image signature verification failed; keeping ${UPDATER_VERSION:-current}"
    record_swap_result failed "signature verification failed for $candidate"
    return 1
  fi

  self_id="$(service_container_id "$UPDATER_SERVICE")"
  self_image="$(docker inspect --format '{{.Config.Image}}' "$self_id" 2>/dev/null || true)"
  if [[ -z "$self_id" || -z "$self_image" ]]; then
    log "could not resolve this updater container; skipping self-update"
    record_swap_result failed "could not resolve the running updater container"
    return 1
  fi

  log "handing the updater swap to a detached helper (${UPDATER_VERSION:-unknown} -> $tag)"
  # --volumes-from takes over the socket and the stack mounts. A -v here would be wrong: paths
  # inside this container are not paths on the host.
  if ! docker run --detach --rm \
    --volumes-from "$self_id" \
    --network none \
    --label aidesk.role=updater-swap \
    --env "COMPOSE_PROJECT=$COMPOSE_PROJECT" \
    --env "COMPOSE_FILE=$COMPOSE_FILE" \
    --env "STACK_ENV_FILE=$STACK_ENV_FILE" \
    --env "HOST_STACK_DIR=$HOST_STACK_DIR" \
    --env "UPDATER_SERVICE=$UPDATER_SERVICE" \
    --env "UPDATER_SWAP_TIMEOUT_SECONDS=$UPDATER_SWAP_TIMEOUT_SECONDS" \
    --env "SWAP_RESULT_FILE=$SWAP_RESULT_FILE" \
    --entrypoint /usr/local/bin/aidesk-update \
    "$self_image" --swap-updater "$candidate" >/dev/null; then
    record_swap_result failed "could not start the detached updater swap helper"
    return 1
  fi
}

update_once() {
  local tag candidate current
  if [[ -n "$TARGET_VERSION" ]]; then
    if [[ ! "$TARGET_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      die "target version is invalid"
      return 1
    fi
    tag="$TARGET_VERSION"
  else
    if ! tag="$(latest_release_tag)"; then
      die "could not determine the latest release"
      return 1
    fi
  fi
  candidate="$(image_ref "$IMAGE_REPOSITORY" "$tag")"
  current="$(current_version 2>/dev/null || true)"

  if [[ "${current#v}" == "${tag#v}" ]]; then
    log "already current: $tag"
    return 0
  fi
  if [[ "$current" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] && ! version_is_newer "$current" "$tag"; then
    log "refusing downgrade from $current to $tag"
    return 0
  fi

  log "new release detected: ${current:-unknown} -> $tag"
  # The page polls before the deployment is done; a result of an older swap must not fail this run.
  clear_swap_result
  PHASE_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  export PHASE_STARTED_AT
  set_phase "verifying" "$tag"
  if ! verify_image "$candidate"; then
    set_phase "failed" "release image is unavailable or did not pass signature verification"
    return 1
  fi
  if ! backup_database "$tag"; then
    set_phase "failed" "database backup failed" "backing-up"
    return 1
  fi
  deploy_with_rollback "$candidate" || return 1
  # Only after the product is healthy: the stack is never left half updated with a swapped
  # updater on top.
  schedule_updater_swap "$tag" || log "updater self-update skipped"
}

main() {
  if [[ "${1:-}" == "--swap-updater" ]]; then
    require_command docker
    require_command jq
    [[ -n "$HOST_STACK_DIR" && "$HOST_STACK_DIR" == /* ]] ||
      { die "--swap-updater needs an absolute HOST_STACK_DIR"; return 1; }
    [[ -n "${2:-}" ]] || { die "--swap-updater needs an image reference"; return 1; }
    swap_updater "$2"
    return
  fi
  validate_config
  if [[ "${UPDATE_ONCE:-false}" == "true" ]]; then
    update_once
    return
  fi

  log "watching releases every ${POLL_INTERVAL_SECONDS}s"
  while true; do
    update_once || log "cycle failed; keeping the current deployment"
    sleep "$POLL_INTERVAL_SECONDS" &
    wait $!
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
