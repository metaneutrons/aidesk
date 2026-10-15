#!/bin/sh
# Qualifies the production Compose setup on this machine: it starts from a clean state and
# becomes ready, takes a ticket with its objects, is backed up, loses its volumes and gets
# everything back from the backup, and prints how long the steps took. It needs the image
# (`docker build --target production --tag aidesk-production .`) and an env file for
# compose.production.yaml with `COMPOSE_PROFILES=bundled`; the project is `aidesk-check`, so
# it does not touch a running deployment. Do not run it against an env file of a real one:
# it deletes the volumes of its own project.
#   ENV_FILE=.env.check APP_PORT=3000 sh scripts/check-production.sh
set -eu
ENV_FILE="${ENV_FILE:?Name an env file for compose.production.yaml}"
APP_PORT="${APP_PORT:-3000}"
export ENV_FILE COMPOSE_PROJECT_NAME=aidesk-check
work="$(pwd)/.check-production"
compose() { docker compose --env-file "$ENV_FILE" -f compose.production.yaml "$@"; }
psql() { compose exec -T postgres psql -U aidesk -d aidesk -v ON_ERROR_STOP=1 -Atq "$@"; }
digest() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]'; }
ready() {
  for _ in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/health/ready")" = 200 ] && return 0
    sleep 1
  done
  return 1
}
seconds() { date +%s; }
clean() { compose down -v >/dev/null 2>&1 || true; rm -rf "$work"; }
trap clean EXIT
clean
mkdir -p "$work"
step=$(seconds)
compose up -d
ready || { compose logs --tail 50; echo "not ready" >&2; exit 1; }
echo "clean start until ready: $(($(seconds) - step)) s"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/v1/projects")" = 401 ]
# A ticket with a message and an attachment, and the objects that its rows name, and one that
# no row names.
project="$(uuid)"; ticket="$(uuid)"; message="$(uuid)"
raw="inbound/$project/original.eml"; file="attachments/$project/file"; orphan="attachments/$project/orphan"
psql <<SQL
insert into project (id, name, slug) values ('$project', 'Check', 'check-$project');
insert into ticket (id, project_id, subject, requester_email, requester_name, language)
  values ('$ticket', '$project', 'Check subject', 'kim@example.test', 'Kim', 'en');
insert into message (id, ticket_id, author_type, author_name, markdown, raw_object_key)
  values ('$message', '$ticket', 'customer', 'Kim', 'Hello check', '$raw');
insert into attachment (message_id, project_id, position, filename, content_type, size, checksum, object_key)
  values ('$message', '$project', 0, 'a.bin', 'application/octet-stream', 6, 'c1', '$file');
SQL
mkdir -p "$work/seed/objects/inbound/$project" "$work/seed/objects/attachments/$project"
printf 'From: kim@example.test\r\n\r\nHello check' > "$work/seed/objects/$raw"
printf '\000\001\002\372\373\374' > "$work/seed/objects/$file"
printf 'orphan' > "$work/seed/objects/$orphan"
: > "$work/seed/manifest.jsonl"
for entry in "$raw message/rfc822" "$file application/octet-stream" "$orphan text/plain"; do
  key="${entry% *}"; type="${entry#* }"
  printf '{"key":"%s","size":%s,"sha256":"%s","contentType":"%s"}\n' "$key" \
    "$(wc -c < "$work/seed/objects/$key" | tr -d ' ')" "$(digest "$work/seed/objects/$key")" "$type" >> "$work/seed/manifest.jsonl"
done
objects() { compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$work/$1:/backup" worker node_modules/.bin/tsx scripts/objects.ts "$2" /backup; }
objects seed import >/dev/null
# The services come back after a restart.
step=$(seconds); compose restart app worker >/dev/null 2>&1; ready
echo "web server and worker restarted, ready after: $(($(seconds) - step)) s"
# Back up, lose everything, restore.
step=$(seconds); sh scripts/production-backup.sh backup "$work/backup" >/dev/null
echo "backup: $(($(seconds) - step)) s"
compose down -v >/dev/null 2>&1
step=$(seconds); compose up -d >/dev/null 2>&1; ready
echo "clean start again until ready: $(($(seconds) - step)) s"
[ "$(psql -c "select count(*) from ticket")" = 0 ]
step=$(seconds); sh scripts/production-backup.sh restore "$work/backup" >/dev/null; ready
echo "restore until ready: $(($(seconds) - step)) s"
[ "$(psql -c "select count(*) from ticket t join message m on m.ticket_id = t.id join attachment a on a.message_id = m.id where t.id = '$ticket' and m.markdown = 'Hello check' and a.object_key = '$file'")" = 1 ]
mkdir -p "$work/after"
objects after export >/dev/null
[ "$(sort "$work/seed/manifest.jsonl")" = "$(sort "$work/after/manifest.jsonl")" ]
# The sweep names nothing that a row names, and keeps the object nobody names because it is young.
sweep="$(compose run --rm --no-deps -T worker node_modules/.bin/tsx scripts/sweep-objects.ts | grep '^{')"
echo "$sweep" | grep -q '"referenced":2' && echo "$sweep" | grep -q '"unreferenced":0' && echo "$sweep" | grep -q '"keptBecauseYoung":1'
echo "the production setup passed: start, restart, backup, loss of the volumes, restore, sweep"
