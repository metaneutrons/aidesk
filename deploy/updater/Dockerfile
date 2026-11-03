# syntax=docker/dockerfile:1
# The updater of the Compose installation (see compose.production.yaml, profile `updater`).
# docker:29-cli multi-arch manifest, pinned for reproducible builds.
FROM docker:29-cli@sha256:27a51d5ab1cd38d9eeaba7b415b8c07bc10c31e1cf1ec8d78f6413fcfab3f44f

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      cosign \
      curl \
      docker-cli-compose \
      jq \
      nodejs \
    && update-ca-certificates

# The version is reported to the control API and lets the detached self-update helper decide
# whether a newer updater image is needed. It is baked in rather than read through the socket.
ARG UPDATER_VERSION=0.0.0-dev
ENV UPDATER_VERSION=${UPDATER_VERSION}

COPY update.sh /usr/local/bin/aidesk-update
COPY control.mjs /usr/local/lib/aidesk-updater/control.mjs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/status',{headers:{authorization:'Bearer '+process.env.UPDATER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/usr/local/lib/aidesk-updater/control.mjs"]
