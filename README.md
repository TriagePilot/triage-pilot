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

Original TriagePilot code is released under the Functional Source License, Version 1.1, Apache 2.0 Future License (`FSL-1.1-Apache-2.0`). Current public versions are Fair Source and source-available, not OSI-approved open source.

Organizations may use, modify, and self-host TriagePilot for their own internal use and access. During a version's FSL period, licensees may not make that version available to others in a competing commercial product or service as defined by the complete [license](LICENSE). This is not a blanket prohibition on commercial use.

Each public version becomes available under Apache License 2.0 on the second anniversary of the date that version is made available. Public Git commits, packages, images, and releases can each establish availability; release manifests record artifact publication dates for provenance and do not delay a source-availability date already recorded in Git history.

The public repository's product is the self-hosted application. Synchronized registry packages are public release artifacts required by the private SaaS dependency boundary; they are not a separately supported SDK, plugin platform, or community extension surface. The separate private SaaS repository remains proprietary and does not convert to Apache 2.0 under this policy.
