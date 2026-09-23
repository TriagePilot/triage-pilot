# Self-Hosted Quickstart

## Requirements

- Docker Engine
- Docker Compose v2
- Permission to create and install a GitHub App in one organization

Create the GitHub App with the [setup guide](../github-app/setup.md) before filling in the environment file.

## Start

```bash
cp .env.example .env
openssl rand -hex 24
openssl rand -hex 32
openssl rand -hex 32
```

Use the generated values for `ADMIN_PASSWORD`, `SESSION_SECRET`, and `GITHUB_WEBHOOK_SECRET`, respectively. In `.env`, also set:

- `ADMIN_USERNAME` to the single administrator login;
- `GITHUB_ORGANIZATION` to the one organization this deployment accepts;
- `GITHUB_APP_ID` to the App ID from GitHub;
- `GITHUB_PRIVATE_KEY` to the App's PEM private key, with line breaks represented as literal `\n` sequences.

`APP_BASE_URL` must be the public HTTPS origin in production. `SESSION_SECRET` must contain at least 32 characters. Do not leave any `replace-with-` placeholder in a production environment, and never commit `.env` or a secret file. Each secret also has a mounted-file form: set only one of `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE`, `SESSION_SECRET` / `SESSION_SECRET_FILE`, `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE`, and `GITHUB_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET_FILE`. For the required read-only mounts and a production reverse-proxy setup, see [Production Compose](production-compose.md).

## Run The Published Image (Recommended)

The release overlay uses the same versioned image for two separate application containers: `web` runs the default web-server command and `worker` overrides it with the worker command. PostgreSQL runs separately from `postgres:16`.

The commands below name Compose files explicitly, so Compose does not automatically load `docker-compose.override.yml`. If your deployment has a local override for secret mounts, bindings, networks, resources, or other site-specific configuration, append it after the release overlay in every command, for example `-f docker-compose.yml -f docker-compose.release.yml -f docker-compose.override.yml`. Later files take precedence.

```bash
docker compose -f docker-compose.yml -f docker-compose.release.yml pull web worker
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.release.yml run --rm web node packages/db/dist/migrate.js
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d web worker
```

The overlay defaults to `ghcr.io/triagepilot/triage-pilot:1.1.1`, published for `linux/amd64` and `linux/arm64`. To use another exact release or pin the release manifest's digest, set the complete reference in `.env` before running Compose. For example, the previous `v1.1.0` release can be pinned exactly:

```dotenv
TRIAGEPILOT_IMAGE=ghcr.io/triagepilot/triage-pilot:1.1.0@sha256:02465d76467f1471b572a9605564c3b67bdbdb23e96cd773c4ca0ab205f39e4d
```

Use the same image reference for both application services; the release overlay enforces that invariant.

## Build From Source

To build the checked-out source instead, use the base Compose file without the release overlay:

```bash
docker compose build --pull
docker compose up -d postgres
docker compose run --rm web node packages/db/dist/migrate.js
docker compose up -d web worker
```

The bundled Postgres database is available to a database client on the host at
`127.0.0.1:5432`, with database, username, and password all set to
`triagepilot`. Set `TRIAGEPILOT_POSTGRES_PORT` in `.env` if port 5432 is already
in use. The database remains bound to localhost by default.

Open `http://localhost:8787` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The dashboard shows the configured organization, selected repositories, recent decisions and failures, and the current worker heartbeat.

Confirm the stack is healthy before configuring GitHub:

```bash
docker compose ps
curl --fail http://localhost:8787/health
```

If the web port is already in use, set `TRIAGEPILOT_WEB_PORT` to an unused local port and set `APP_BASE_URL` to that same URL before starting the services. Recreate `web` and `worker` after changing `.env`. For the published image, run:

```bash
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --force-recreate web worker
```

For a build-from-source deployment, run the same command without the two `-f` arguments.

Install the configured GitHub App in `GITHUB_ORGANIZATION` on only the repositories this deployment should process.

Add `.github/triagepilot.yml` to each selected repository. Missing configuration and `mode: shadow` perform reads and record decisions without GitHub writes. The repository file at the pull request's base commit is the only mode control; an unmerged head change cannot enable writes for its own pull request. Follow the [shadow-to-enforce guide](../operations/shadow-to-enforce.md) before changing it to `mode: enforce`.
