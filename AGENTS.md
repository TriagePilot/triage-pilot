# AGENTS.md

TriagePilot is an AGPL-3.0 self-hosted GitHub pull-request routing application. This repository is the canonical development target.

## Architecture

- `apps/web`: administrator login, operations UI and API, and organization-scoped GitHub webhooks.
- `apps/worker`: PostgreSQL job consumer, routing processor, recovery, heartbeat, and retention.
- `packages/config`: `.github/triagepilot.yml` parsing.
- `packages/core`: pure ownership, risk, and routing logic.
- `packages/db`: PostgreSQL schema, migrations, jobs, routing decisions, heartbeat, and retention.
- `packages/github`: GitHub App authentication, webhooks, and API adapter.
- `packages/shared`: shared types and constants.

Read `docs/specs/2026-07-07-open-source-self-hosting-design.md` before planning product work. Read `docs/architecture.md` before changing process boundaries. Read `docs/github-app/repository-configuration.md` before changing the repository configuration contract.

## Development Rules

- Keep the runtime portable and container-first.
- Do not add provider-specific deployment files, private infrastructure, hosted-service runbooks, or environment-specific secrets templates.
- Preserve shadow mode as the default. Only `mode: enforce` in `.github/triagepilot.yml` permits GitHub writes.
- Add or update tests for behavior changes.
- Use migrations for schema changes; never mutate an existing released migration.
- Keep secrets out of source control. Administrator and GitHub App credentials are supplied through environment or mounted-file configuration and are not stored in PostgreSQL.

## Verification

Run from the repository root:

```bash
pnpm check
pnpm test
pnpm build
docker build .
```

Before publishing, also run Gitleaks and scan tracked files for provider-specific or private deployment material.
