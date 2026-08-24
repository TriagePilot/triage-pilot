# TriagePilot

TriagePilot is a self-hosted, risk-based pull request router for GitHub teams.

It receives GitHub pull request events, scores PR risk, matches changed files to ownership rules, and records the routing decision and action outcome. Repositories default to shadow mode so teams can evaluate decisions before enabling GitHub writes.

## Self-Hosted Quickstart

```bash
cp .env.example .env
openssl rand -hex 24
openssl rand -hex 32
openssl rand -hex 32
```

Use the generated values for `ADMIN_PASSWORD`, `SESSION_SECRET`, and `GITHUB_WEBHOOK_SECRET`. Set `ADMIN_USERNAME`, `GITHUB_ORGANIZATION`, `GITHUB_APP_ID`, and `GITHUB_PRIVATE_KEY` in `.env`; leave no `replace-with-` values. Never commit `.env` or a GitHub App private key. For mounted secrets, use the corresponding `_FILE` setting instead of the direct setting; the full quickstart explains the required read-only mounts.

Then start TriagePilot:

```bash
docker compose build --pull
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
docker compose up -d web worker
```

Open `http://localhost:8787` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. See the [full quickstart](docs/self-hosting/quickstart.md) for GitHub App creation, selected-repository installation, secret files, and production notes.

## Deployment Model

The supported public deployment is Docker Compose with `web`, exactly one `worker`, and PostgreSQL. One deployment manages one configured GitHub organization and multiple selected repositories in that organization.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Repository configuration](docs/github-app/repository-configuration.md)
- [Shadow-to-enforce rollout](docs/operations/shadow-to-enforce.md)
- [Release checklist](docs/self-hosting/release-checklist.md)

## License

TriagePilot is licensed under AGPL-3.0.
