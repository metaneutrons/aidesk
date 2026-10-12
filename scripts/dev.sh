#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null
if [ ! -f .env.development ]; then
  command -v openssl >/dev/null
  umask 077
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
  printf '%s\n' 'Generated private local credentials in .env.development. Keep this file local.'
fi
# Later additions are appended to an existing file; present values are kept.
ensure_secret() {
  if ! grep -q "^$1=" .env.development; then
    command -v openssl >/dev/null
    [ -z "$(tail -c 1 .env.development)" ] || printf '\n' >> .env.development
    (umask 077 && printf '%s=%s\n' "$1" "$(openssl rand -hex "$2")" >> .env.development)
    printf 'Added %s to .env.development.\n' "$1"
  fi
}
ensure_secret KEYCLOAK_ADMIN_PASSWORD 16
ensure_secret DEV_SSO_OIDC_CLIENT_SECRET 32
ensure_secret DEV_SSO_USER_PASSWORD 16
# Prints the root certificate of the local HTTPS proxy, for clients that
# verify TLS (for example NODE_EXTRA_CA_CERTS).
if [ "${1:-}" = "https-ca" ]; then
  exec docker compose --env-file .env.development -f compose.dev.yaml exec -T https \
    cat /data/caddy/pki/authorities/local/root.crt
fi
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  exec docker compose --env-file .env.development -f compose.dev.yaml -f compose.cloud.yaml "$@"
fi
exec docker compose --env-file .env.development -f compose.dev.yaml "$@"
