# Self-Hosted Quickstart

## Requirements

- Docker Engine
- Docker Compose v2
- Git, to obtain the Compose and environment files
- Permission to create and install a GitHub App in one organization
- A public HTTPS origin reachable by GitHub for webhook delivery; see [Production Compose](production-compose.md) for the reverse-proxy setup

Register the GitHub App with the [setup guide](../github-app/setup.md) before filling in the environment file. Install it on the selected test repository after the web service and public webhook endpoint are reachable.

## Get the deployment files

Pulling the container image alone does not provide the Compose files or `.env.example`. Check out the matching release, then run the remaining commands from that directory:

```bash
git clone --branch v1.2.0 --depth 1 https://github.com/TriagePilot/triage-pilot.git triagepilot
cd triagepilot
```

The tag checkout is a detached HEAD, which is expected for a version-pinned deployment. Use a separate directory and Compose project for an evaluation if another deployment already exists; do not reuse its database volume, environment file, or ports.

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

The overlay defaults to `ghcr.io/triagepilot/triage-pilot:1.2.0`, published for `linux/amd64` and `linux/arm64`. To use another exact release or pin the release manifest's digest, set the complete reference in `.env` before running Compose. For example, the previous `v1.1.0` release can be pinned exactly:

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

Open the configured `APP_BASE_URL` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. For production, use the public HTTPS origin through your reverse proxy. The loopback URL below is a local health diagnostic, not a replacement for the public webhook endpoint. The dashboard shows the configured organization, selected repositories, recent decisions and failures, and the current worker heartbeat.

Confirm the stack is healthy before configuring GitHub:

```bash
docker compose -f docker-compose.yml -f docker-compose.release.yml ps
curl --fail http://localhost:8787/health
```

Expected health response: `{"ok":true,"service":"triagepilot-web"}`. In **System health**, also confirm that the worker heartbeat is current; a healthy web response alone does not establish that routing jobs are being processed. For a source build, omit the two `-f` arguments in the status command. Include any local override consistently as described above.

If the web port is already in use, set `TRIAGEPILOT_WEB_PORT` to an unused local port and set `APP_BASE_URL` to that same URL before starting the services. Recreate `web` and `worker` after changing `.env`. For the published image, run:

```bash
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --force-recreate web worker
```

For a build-from-source deployment, run the same command without the two `-f` arguments.

Install the configured GitHub App in `GITHUB_ORGANIZATION` on only the repositories this deployment should process.

Add `.triagepilot.yml` to each selected repository. Missing configuration and `mode: shadow` perform reads and record decisions without GitHub writes. The repository file at the pull request's base commit is the only mode control; an unmerged head change cannot enable writes for its own pull request. Follow the [shadow-to-enforce guide](../operations/shadow-to-enforce.md) before changing it to `mode: enforce`.

## Confirm the first shadow decision

1. Choose one representative test repository in the configured organization. For a new evaluation, commit this minimal `.triagepilot.yml` at the repository root on the branch that will receive the test pull request:

   ```yaml
   version: 1
   mode: shadow
   ```

   This uses default risk and ownership settings; an empty reviewer selection can be valid. To evaluate actual owner/fallback choices, add eligible individual GitHub handles using the [configuration reference](../github-app/repository-configuration.md) or [repository setup prompt](../../SETUP_PROMPT.md). Preserve existing repository policy when adapting an existing configuration. Confirm the effective configuration is `shadow` on the trusted base before continuing; adding shadow mode only in the test PR is insufficient.

2. Confirm that the App installation selects this repository, the webhook endpoint is reachable, and the repository appears under **Repositories**. Check the App's recent webhook deliveries if it does not. Personal-account repositories or a different organization are outside this deployment's scope.
3. Open a non-draft pull request authored by a person, with a representative change, against the branch containing the shadow configuration. Choose a branch not excluded by your policy. Existing PRs are not proof that a new installation has received an event; use a subsequent supported PR event or the recovery flow below.
4. In **Routing decisions**, find the row for that repository and PR. Confirm its mode is `shadow`, then inspect the risk score/breakdown and selected reviewers. **Configuration** shows the trusted effective policy. Use the query below when you need to confirm the exact persisted head and base configuration revision. Low-risk routing can select no human reviewer; medium risk selects one, and high risk selects one by default or two when configured.
5. If you need to verify persistence directly, run this read-only query with the same Compose files and local overrides used to start the deployment:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.release.yml exec postgres psql -U triagepilot triagepilot -c \
     "select r.owner || '/' || r.name as repository, d.pull_number, d.head_sha, d.repository_config_revision, d.mode, d.risk_score, d.selected_reviewers, d.action_status, d.created_at from routing_decisions d join repositories r on r.id = d.repository_id order by d.created_at desc limit 5;"
   ```

   Identify the row for your test PR and head. The expected mode is `shadow` and `action_status` is `not_applied`; reviewer requests, approvals, labels, comments, and checks are not written to GitHub. For an external database, run the equivalent query through your database's read-only operator connection.

The first successful outcome is a persisted decision for the intended PR and head that you can explain. Review a small sample and tune ownership/risk policy before considering enforcement. Shadow mode does not produce the enforce-mode policy check; do not make that check required during the initial evaluation.

### If no decision appears

- **No selected repository:** verify the configured organization and App repository selection. If the App was installed before the endpoint was reachable, follow the setup guide's [delivery recovery steps](../github-app/setup.md#verify-installation-delivery).
- **No accepted PR event:** inspect recent GitHub App deliveries for `/webhooks/github`. Verify the public HTTPS URL, event subscriptions, matching webhook secret, and response. A local `/health` response does not verify external webhook reachability.
- **Event accepted, no decision:** check the worker heartbeat and logs, draft state, and effective policy. Use [job troubleshooting](../troubleshooting/jobs.md) for queued/failed work. A webhook acknowledgment alone does not prove that a decision was persisted.
- **An existing PR needs evaluation:** for a known active repository, paste its URL into **Run a missing change request** and select **Run routing**. For a recorded decision, use **Re-run routing**. These recovery actions process the current trusted configuration; confirm it remains `shadow` first. See [routing recovery](../troubleshooting/jobs.md#recover-missing-or-stalled-routing).

## Inspect analytics

After administrator login, open **Analytics** for historical enforced outcomes or shadow projections and current tracked reviewer workload. [Analytics and reviewer backlog](../operations/analytics.md) explains the one-reviewer baseline, editable effort estimate, 90-day coverage, and live freshness. This requires no additional GitHub permission or repository configuration switch.

## Inspect open pull requests

After administrator login, open **Pull requests** for the grouped queue of open pull requests in selected repositories, excluding drafts and bot-authored pull requests. See [Open pull-request queue](../operations/pull-request-queue.md) for filters, evidence, freshness, and coverage.
