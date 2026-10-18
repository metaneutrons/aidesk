#!/bin/sh
# Qualifies the production Compose setup on this machine: it starts from a clean state and
# becomes ready, takes a ticket with its objects, is backed up, loses its volumes and gets
# everything back from the backup, and prints how long the steps took. It needs the image
# (`docker build --target production --tag aidesk-production .`) and an env file for
# compose.production.yaml with `COMPOSE_PROFILES=bundled`; the project is `aidesk-check`, so
# it does not touch a running deployment. Do not run it against an env file of a real one:
# it deletes the volumes of its own project.
#   ENV_FILE=.env.check APP_PORT=3000 sh scripts/check-production.sh
# BULK_TICKETS and BULK_OBJECTS (default 0) add that many tickets with three messages each and objects of
# 50 KB to the data, so that the times of the backup and the restore are those of a larger deployment; the
# counts are checked after the restore.
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
# The proxy, when the env file turns the profile on: TLS with the certificate of its own CA (the env file
# says SITE_ADDRESS=localhost and TLS_DIRECTIVE="tls internal"), the redirect, the headers, the limit of a
# body and the way through to the web server.
if grep -q '^COMPOSE_PROFILES=.*proxy' "$ENV_FILE"; then
  site="$(sed -n 's/^SITE_ADDRESS=//p' "$ENV_FILE")"
  https_port="$(sed -n 's/^PROXY_HTTPS_PORT=//p' "$ENV_FILE")"; https_port="${https_port:-443}"
  http_port="$(sed -n 's/^PROXY_HTTP_PORT=//p' "$ENV_FILE")"; http_port="${http_port:-80}"
  url="https://$site:$https_port"
  secure() { curl -s --cacert "$work/proxy-ca.crt" --resolve "$site:$https_port:127.0.0.1" "$@"; }
  for _ in $(seq 1 60); do
    compose cp proxy:/data/caddy/pki/authorities/local/root.crt "$work/proxy-ca.crt" >/dev/null 2>&1 && break
    sleep 1
  done
  for _ in $(seq 1 60); do
    [ "$(secure -o /dev/null -w '%{http_code}' "$url/api/health/ready")" = 200 ] && break
    sleep 1
  done
  [ "$(secure -o /dev/null -w '%{http_code}' "$url/api/health/ready")" = 200 ]
  # Without the root certificate the handshake has to fail.
  if curl -s -o /dev/null --resolve "$site:$https_port:127.0.0.1" "$url/api/health/ready"; then
    echo "the certificate was accepted without its CA" >&2; exit 1
  fi
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$http_port/")" = 308 ]
  headers="$(secure -D - -o /dev/null "$url/login")"
  echo "$headers" | grep -qi '^strict-transport-security: max-age=31536000'
  echo "$headers" | grep -qi '^x-content-type-options: nosniff'
  echo "$headers" | grep -qi '^x-frame-options: SAMEORIGIN'
  if echo "$headers" | grep -qi '^server:'; then echo "the Server header is sent" >&2; exit 1; fi
  [ "$(secure -o /dev/null -w '%{http_code}' "$url/api/v1/projects")" = 401 ]
  # The limit is applied while the body is read, so the route has to be one that reads it: the sign-in reads
  # its JSON before it answers (a route that answers 401 first would not show the limit). A body below the
  # limit has to get through to the application, which answers it in some way other than 413.
  head -c 45000000 /dev/zero > "$work/body-over"
  head -c 30000000 /dev/zero > "$work/body-under"
  post() { secure -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @"$1" "$url/api/auth/sign-in/email"; }
  over="$(post "$work/body-over")"
  under="$(post "$work/body-under")"
  echo "body of 45 MB: $over, body of 30 MB: $under"
  [ "$over" = 413 ] && [ "$under" != 413 ] && [ "$under" != 000 ]
  rm -f "$work/body-over" "$work/body-under"
  echo "proxy: TLS with a certificate of its own CA, redirect, headers, limit of a body, way through"
fi
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
bulk_tickets="${BULK_TICKETS:-0}"; bulk_objects="${BULK_OBJECTS:-0}"
if [ "$bulk_tickets" -gt 0 ]; then
  psql <<SQL
insert into ticket (id, project_id, subject, requester_email, requester_name, language)
  select gen_random_uuid(), '$project', 'Bulk ' || n, 'bulk' || (n % 5000) || '@example.test', 'Bulk', 'en'
  from generate_series(1, $bulk_tickets) n;
insert into message (id, ticket_id, author_type, author_name, markdown)
  select gen_random_uuid(), t.id, 'customer', 'Bulk', repeat('Bulk message text. ', 40)
  from ticket t cross join generate_series(1, 3) where t.subject like 'Bulk %';
SQL
fi
mkdir -p "$work/seed/objects/inbound/$project" "$work/seed/objects/attachments/$project"
printf 'From: kim@example.test\r\n\r\nHello check' > "$work/seed/objects/$raw"
printf '\000\001\002\372\373\374' > "$work/seed/objects/$file"
printf 'orphan' > "$work/seed/objects/$orphan"
: > "$work/seed/manifest.jsonl"
if [ "$bulk_objects" -gt 0 ]; then
  mkdir -p "$work/seed/objects/bulk/$project"
  i=0
  while [ "$i" -lt "$bulk_objects" ]; do
    head -c 51200 /dev/urandom > "$work/seed/objects/bulk/$project/$i"
    printf '{"key":"bulk/%s/%s","size":51200,"sha256":"%s","contentType":"application/octet-stream"}\n' \
      "$project" "$i" "$(digest "$work/seed/objects/bulk/$project/$i")" >> "$work/seed/manifest.jsonl"
    i=$((i + 1))
  done
fi
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
echo "data: $(psql -c "select count(*) from ticket") tickets, $(psql -c "select count(*) from message") messages, $(psql -c "select pg_size_pretty(pg_database_size('aidesk'))") in the database, $((bulk_objects + 3)) objects"
[ "$(psql -c "select count(*) from ticket")" = "$((bulk_tickets + 1))" ]
[ "$(psql -c "select count(*) from ticket t join message m on m.ticket_id = t.id join attachment a on a.message_id = m.id where t.id = '$ticket' and m.markdown = 'Hello check' and a.object_key = '$file'")" = 1 ]
mkdir -p "$work/after"
objects after export >/dev/null
[ "$(sort "$work/seed/manifest.jsonl")" = "$(sort "$work/after/manifest.jsonl")" ]
# The sweep names nothing that a row names, and keeps the object nobody names because it is young.
sweep="$(compose run --rm --no-deps -T worker node_modules/.bin/tsx scripts/sweep-objects.ts | grep '^{')"
echo "$sweep" | grep -q '"referenced":2' && echo "$sweep" | grep -q '"unreferenced":0' && echo "$sweep" | grep -q "\"keptBecauseYoung\":$((bulk_objects + 1))"
echo "the production setup passed: start, restart, backup, loss of the volumes, restore, sweep"
