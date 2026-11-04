# Updating a Compose installation

This is for an installation that runs from `compose.production.yaml`. An installation on a platform that deploys the product
itself (Coolify, for example) is updated where it is deployed; the updater described here is not for it.

## Releases and images

A release is made by merging the release pull request that release-please keeps up to date. The tag `vX.Y.Z` then starts
`release-image.yml`, which

1. builds two images for `linux/amd64` and `linux/arm64`, each on a runner of its own architecture, with a software bill of
   materials and a provenance statement: the product, `ghcr.io/metaneutrons/aidesk`, and the updater,
   `ghcr.io/metaneutrons/aidesk-updater` (the sources are `Dockerfile`, target `production`, and `deploy/updater`);
2. tags both `X.Y.Z`, `X.Y` and `latest`, and gives both the label `org.opencontainers.image.version` with the version without
   the `v`;
3. signs both without a key, with Sigstore (the identity is this workflow, run for a release tag of this repository);
4. checks from outside that the signature holds for exactly that identity, that a signature of another identity is refused, and
   that every architecture carries the version label;
5. publishes the GitHub release last. A release that is not published has no images to rely on, and the updater only looks at
   published releases.

To check an image by hand:

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/metaneutrons/aidesk/\.github/workflows/release-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  ghcr.io/metaneutrons/aidesk:X.Y.Z
```

## Starting from a release

Without the updater, pull the image first and name it in the environment file; the Compose file never pulls the image of the
product itself (`pull_policy: never`):

```bash
docker pull ghcr.io/metaneutrons/aidesk:X.Y.Z
echo 'AIDESK_IMAGE=ghcr.io/metaneutrons/aidesk:X.Y.Z' >> .env.production
docker compose --env-file .env.production -f compose.production.yaml up -d --no-build
```

Without `AIDESK_IMAGE` the Compose file builds the image from the sources next to it, as before.

## The updater

The updater is the service of the profile `updater`. It needs the Docker socket, which is as good as root on the machine, so
turn it on only where that is acceptable. It reads the Compose file and writes the two image pins into the environment file.

```bash
# .env.production
COMPOSE_PROFILES=bundled,proxy,updater
UPDATER_TOKEN=<openssl rand -hex 32>
```

| Variable                         | Default               | Meaning                                                                                  |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `UPDATER_TOKEN`                  | none                  | 32 characters or more. The updater does not start without it, nor with the example text. |
| `UPDATER_URL`                    | `http://updater:8080` | Where the product asks the updater.                                                      |
| `UPDATER_POLL_INTERVAL_SECONDS`  | `3600`                | How often it looks for a release (300 or more).                                          |
| `UPDATER_AUTO_APPLY`             | `false`               | Install a waiting release at the maintenance time without being asked.                   |
| `UPDATER_MAINTENANCE_TIME`, `TZ` | `02:00`, `UTC`        | The maintenance window; the owner changes it on the settings page.                       |
| `UPDATER_BACKUP_ENABLED`         | `true`                | `false` when the database is not the bundled one and you back it up yourself.            |
| `UPDATER_BACKUP_RETENTION_DAYS`  | `14`                  | How long the dumps of earlier updates are kept.                                          |
| `UPDATER_SELF_UPDATE`            | `true`                | `false` keeps the updater as it is when the product is updated.                          |
| `GITHUB_TOKEN`                   | none                  | Only to raise the limit of the GitHub API for the check of the release.                  |
| `AIDESK_ENV_FILE`                | `.env.production`     | The environment file that the updater writes the pins into.                              |

The owner uses it on the settings page, "Updates": the version that runs, the latest release, the steps of an update, and the
maintenance window (manual or automatic). Nothing is installed without the owner unless the automatic mode is on.

## What an update does

1. It reads the latest published release and refuses a downgrade or a release that is already running.
2. It pulls the image and checks the signature against the identity above. An image that does not pass is not used.
3. It dumps the bundled database (`pg_dump --format custom`) into the volume `updater-backups` and keeps the dumps of the last
   14 days. Without a bundled database and without `UPDATER_BACKUP_ENABLED=false` it stops here.
4. It runs the migrations in a container of their own, and only when they end well replaces the web server and the worker with
   the new image. The database and the storage are not touched.
5. It waits until `/api/health/ready` answers. Only then it writes `AIDESK_IMAGE` into the environment file, so that a later
   `docker compose up` keeps the version that was installed.
6. It replaces itself with the image of the same release (see below).

The product does not answer for a short time during step 4. The settings page keeps asking, says so, and loads itself again when
the update is done.

## When an update fails

The updater puts the previous image back when the new one does not become ready, and when the migrations fail. It tells the
settings page which step failed and that the rollback ran. The images come back; the database is not restored by the updater.
What that means, as shown by `deploy/updater/test-rollback.sh` with real containers:

| Case                                 | What happens                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The web server of the new image dies | The previous image is put back and is ready again; the new one is not pinned.                                                                                                                     |
| A migration fails                    | Nothing of the run of the migrations stays in the database (a table made before the failing statement is not there, the list of applied migrations is unchanged). The previous image is put back. |
| The backup fails or is empty         | The update stops before anything is replaced.                                                                                                                                                     |
| The signature does not hold          | The image is not used and nothing is replaced.                                                                                                                                                    |

A migration that succeeded and a release that then does not start leaves the database in the new state. The previous image then
runs on a schema that is newer than it, which works only as long as the migration did not remove what the old version needs. If
it does not run, restore the dump of that update:

```bash
compose="docker compose --env-file .env.production -f compose.production.yaml"
$compose --profile updater cp updater:/backups/<the dump of the update> ./restore.dump
$compose stop app worker
$compose exec -T postgres pg_restore -U aidesk -d aidesk --clean --if-exists --no-owner < restore.dump
$compose up -d app worker
```

The `pg_restore` and the start of the two services were tried against a dump that an update made. The copy out of the volume of
the updater (`cp`) was not.

## The updater updates itself

After a healthy update of the product the updater verifies the image of the same release (`aidesk-updater`, the same signing
identity) and hands the replacement to a detached container that runs from the current image, because a broken new image could
not roll anything back. It starts the new updater, waits until it is healthy, writes `UPDATER_IMAGE` into the environment file,
and puts the old one back if that fails. The result is shown on the settings page. Set `UPDATER_SELF_UPDATE=false` to keep it as it
is.

## Limits

- A release that needs a change of the Compose file (a new required variable, a new service) is not applied by the updater: the
  replacement fails and the rollback runs. Such a release says so in its notes, and you change the file yourself first.
- An image that was built on the machine has no version label and counts as older than any release; the first update replaces it.
- The updater has not yet updated an installation from a signed release. Release 0.2.0 (4 November 2026) showed that the images
  are signed with the identity above, that `cosign verify` accepts them from outside, that both architectures of both images
  carry the label `org.opencontainers.image.version` without the `v`, and that the packages can be pulled without credentials.
  What the first update from one release to the next still has to show is the signature check as the updater calls it, the
  pull by the updater and the swap of the updater itself. `test-rollback.sh` replaces the signature check and the pull and uses
  local images made from one base image.
- The restore of a dump is a manual step.
- Only an installation from `compose.production.yaml` is meant for the updater.

## Tests

- `deploy/updater/control.test.mjs` and `deploy/updater/test-update.sh`: the control API and the worker with a replaced `docker`.
- `deploy/updater/test-rollback.sh [base-image]`: a real stack (bundled database and storage, web server, worker) updated by
  the real worker to a good release, to an image whose web server dies, and to an image with a migration that fails, with the
  counter-probe of the same migration without the fault and the restore of the dump of an update. It needs Docker and a built
  base image (`docker build --target production --tag aidesk-production .`) and runs in CI after the production image.
- `tests/updates.test.ts` and `tests/e2e/updates.spec.ts`: the way from the settings page to the updater, against a server of
  the test and the stand-in of the development stack.
