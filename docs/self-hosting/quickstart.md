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

Then build the current application images, start the database, apply migrations,
and start the services:

```bash
docker compose build --pull
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
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

If the web port is already in use, set `TRIAGEPILOT_WEB_PORT` to an unused local port and set `APP_BASE_URL` to that same URL before starting the services. Recreate `web` and `worker` after changing `.env`:

```bash
docker compose up -d --force-recreate web worker
```

Install the configured GitHub App in `GITHUB_ORGANIZATION` on only the repositories this deployment should process.

Add `.github/triagepilot.yml` to each selected repository. Missing configuration and `mode: shadow` perform reads and record decisions without GitHub writes. The repository file at the pull request's base commit is the only mode control; an unmerged head change cannot enable writes for its own pull request. Follow the [shadow-to-enforce guide](../operations/shadow-to-enforce.md) before changing it to `mode: enforce`.
