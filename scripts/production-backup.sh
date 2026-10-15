#!/bin/sh
# Backup and restore of a deployment that runs from compose.production.yaml with the
# bundled PostgreSQL (the profile `bundled`; put COMPOSE_PROFILES=bundled in the env file).
# The objects are copied through the S3 API, so they can live in any storage; for a
# database of your own use the backup tool of that database instead of this script.
#
#   sh scripts/production-backup.sh backup  <directory>   the directory must not exist yet
#   sh scripts/production-backup.sh restore <directory>   into a stack that is up (postgres and storage)
#
# The database is dumped first and the objects after it: an object is stored before the row
# that names it, so a copy of the objects that is newer than the dump holds objects that no
# row names yet (the sweep removes them), while the other order could leave a row without
# its object.
set -eu
env_file="${ENV_FILE:-.env.production}"
compose() { docker compose --env-file "$env_file" -f compose.production.yaml "$@"; }
digest() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
mode="${1:-}"
directory="${2:-}"
[ -n "$mode" ] && [ -n "$directory" ] || { echo "Usage: $0 backup|restore <directory>" >&2; exit 2; }
objects() {
  # The directory of the copy is mounted into a container of the image, as the user that
  # owns it on this machine.
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
    -v "$(cd "$directory" && pwd)/objects-copy:/backup" worker \
    node_modules/.bin/tsx scripts/objects.ts "$1" /backup
}
case "$mode" in
  backup)
    [ ! -e "$directory" ] || { echo "$directory exists already" >&2; exit 1; }
    mkdir -p "$directory/objects-copy"
    compose exec -T postgres pg_dump -U aidesk -d aidesk --format=custom --no-owner > "$directory/database.dump"
    objects export
    (cd "$directory" && digest database.dump objects-copy/manifest.jsonl > SHA256SUMS)
    echo "Backup written to $directory"
    ;;
  restore)
    [ -f "$directory/database.dump" ] && [ -f "$directory/objects-copy/manifest.jsonl" ] ||
      { echo "$directory is not a finished backup" >&2; exit 1; }
    (cd "$directory" && digest -c SHA256SUMS)
    # Nothing writes while the data is replaced.
    compose stop app worker || true
    compose up -d postgres storage
    compose exec -T postgres pg_restore -U aidesk -d aidesk --clean --if-exists --no-owner < "$directory/database.dump"
    objects import
    # Migrations run again (they change nothing) and the services start.
    compose up -d
    echo "Restored from $directory. Check /api/health/ready, then:"
    echo "  docker compose --env-file $env_file -f compose.production.yaml run --rm --no-deps -T worker node_modules/.bin/tsx scripts/sweep-objects.ts"
    ;;
  *)
    echo "Usage: $0 backup|restore <directory>" >&2
    exit 2
    ;;
esac
