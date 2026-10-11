#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null
if [ ! -f .env.development ]; then
  command -v openssl >/dev/null
  umask 077
  mkdir -p .local
  pg_password=$(openssl rand -hex 24)
  auth_secret=$(openssl rand -hex 32)
  encryption_key=$(openssl rand -hex 32)
  s3_access=$(openssl rand -hex 16)
  s3_secret=$(openssl rand -hex 32)
  owner_password=$(openssl rand -hex 16)
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$pg_password"
    printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret"
    printf 'ENCRYPTION_KEY=%s\n' "$encryption_key"
    printf 'S3_ACCESS_KEY=%s\n' "$s3_access"
    printf 'S3_SECRET_KEY=%s\n' "$s3_secret"
    printf 'DEV_OWNER_PASSWORD=%s\n' "$owner_password"
  } > .env.development
  printf '{"identities":[{"name":"aidesk-dev","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' "$s3_access" "$s3_secret" > .local/s3.json
  printf '%s\n' 'Generated private local credentials in .env.development. Keep this file local.'
fi
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  exec docker compose --env-file .env.development -f compose.dev.yaml -f compose.cloud.yaml "$@"
fi
exec docker compose --env-file .env.development -f compose.dev.yaml "$@"
