# Production Compose

Use Docker Compose for the first supported self-hosted production path.

## Start Order

```bash
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
docker compose up -d web worker
```

The supported stack is `web`, exactly one `worker`, and PostgreSQL. Do not scale the worker above one replica.

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

Run the same migration command before starting `web` and `worker`.

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
