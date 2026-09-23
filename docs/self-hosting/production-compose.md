# Production Compose

Use Docker Compose for the first supported self-hosted production path. The recommended deployment uses the versioned public image through `docker-compose.release.yml`; build-from-source Compose remains available when you need to inspect or modify the application.

Explicit `-f` arguments disable automatic loading of `docker-compose.override.yml`. Append every local deployment override after `docker-compose.release.yml` in all commands so secret mounts, host bindings, networks, resource limits, and other production settings remain active. For example, use `-f docker-compose.yml -f docker-compose.release.yml -f docker-compose.override.yml`; later files take precedence.

## Start Order

```bash
docker compose -f docker-compose.yml -f docker-compose.release.yml pull web worker
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.release.yml run --rm web node packages/db/dist/migrate.js
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d web worker
```

The supported stack is `web`, exactly one `worker`, and PostgreSQL. The web and worker containers use the same `TRIAGEPILOT_IMAGE` reference but start different commands. Do not scale the worker above one replica.

The overlay defaults to the repository's current release tag. For an immutable production deployment, set `TRIAGEPILOT_IMAGE` in `.env` to the version-and-digest reference recorded in that release's `release-manifest.json`. Update both application services together by changing this single value.

To build from source, omit `docker-compose.release.yml`, run `docker compose build --pull`, and use the base `docker compose` command for the same start order.

The production image runs precompiled JavaScript directly on Node.js as an unprivileged user. It intentionally does not include pnpm, TypeScript, tests, or repository source; use the documented `node` migration command inside the image rather than source-checkout package scripts.

## TLS

Run TriagePilot behind a reverse proxy such as Caddy or Nginx and set `APP_BASE_URL` to the public HTTPS origin. When the proxy runs on the same host, bind the web container to loopback so Docker does not expose the dashboard directly:

```dotenv
APP_BASE_URL=https://triage.example.com
TRIAGEPILOT_WEB_BIND=127.0.0.1
TRIAGEPILOT_WEB_PORT=8787
```

Point the reverse proxy at `http://127.0.0.1:8787`, terminate TLS there, and use the same public HTTPS origin in the GitHub App's homepage and webhook URLs. If the proxy runs on another host, use a private network binding that host can reach; do not expose the administrator dashboard without TLS.

The web service listens on host port `8787` by default. Set `TRIAGEPILOT_WEB_BIND` and `TRIAGEPILOT_WEB_PORT` when the reverse proxy needs a different local binding. The automated Compose smoke test binds only to loopback and asks Docker to allocate a free host port, so it does not collide with an existing stack.

## Administrator Login

TriagePilot has one administrator identity configured by `ADMIN_USERNAME` and `ADMIN_PASSWORD`. A successful login creates a stateless, signed session valid for 12 hours. The cookie is `HttpOnly`, uses `SameSite=Strict`, and is marked `Secure` when `APP_BASE_URL` uses HTTPS. Five failed attempts for the same username and source address within 15 minutes lock that pair for 15 minutes; restarting `web` clears the in-memory throttle.

## External Postgres

Set `DATABASE_URL` to the external PostgreSQL connection string. In a local Compose override, put the `postgres` service behind a profile and reset the `web` and `worker` dependencies so Compose does not start or wait for the bundled database:

```yaml
services:
  postgres:
    profiles: [bundled-database]
  web:
    depends_on: !reset {}
  worker:
    depends_on: !reset {}
```

Run the same migration command before starting `web` and `worker`. Include the release overlay followed by your local external-database override in every application command when deploying the published image.

## Secrets

Generate independent administrator password, session-signing secret, and webhook secret values. Runtime credentials remain in the environment or mounted files and are not written to PostgreSQL.

| Setting | Direct variable | File variable |
| --- | --- | --- |
| Administrator username | `ADMIN_USERNAME` | — |
| Administrator password | `ADMIN_PASSWORD` | `ADMIN_PASSWORD_FILE` |
| Session signing secret (at least 32 characters) | `SESSION_SECRET` | `SESSION_SECRET_FILE` |
| Configured organization | `GITHUB_ORGANIZATION` | — |
| GitHub App ID | `GITHUB_APP_ID` | — |
| Private key | `GITHUB_PRIVATE_KEY` | `GITHUB_PRIVATE_KEY_FILE` |
| Webhook secret | `GITHUB_WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET_FILE` |

Do not set both the direct and file form of the same secret. Mount secret files read-only and set each `_FILE` value to its in-container path. The worker requires the App ID and private key but does not require or receive the webhook secret.

The production image runs as UID/GID `1000:1000`, so every bind-mounted secret must be readable by that identity. Either make the file owned by `1000:1000` with mode `0400`, or keep it in a host directory accessible only to the deployment administrator and give the file mode `0444`; the read-only mount prevents container-side modification. A root-owned `0600` file is intentionally unreadable to the non-root application and prevents startup.
