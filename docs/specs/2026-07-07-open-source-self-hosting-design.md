# TriagePilot Minimal Open Source Self-Hosting Design

Date: 2026-07-07
Revised: 2026-08-18
Status: Implemented public release design

## Summary

TriagePilot is an AGPL-3.0, self-hosted GitHub pull-request router. The open-source product is deliberately scoped to one administrator, one GitHub organization, and multiple repositories in that organization.

The supported deployment is a Docker Compose stack containing the web application, one worker, and PostgreSQL. TriagePilot processes GitHub events asynchronously, records routing decisions, defaults repositories to shadow mode, and can request reviewers or perform other configured routing actions in enforce mode.

The OSS product is a complete small-instance deployment, not a multi-tenant or horizontally scalable platform. A future commercial SaaS may reuse the domain logic and event-driven processing model, but SaaS platform concerns do not belong in this repository's OSS scope.

## Goals

- Provide a straightforward Docker Compose deployment for one GitHub organization.
- Support multiple repositories through one organization installation of a user-created GitHub App.
- Provide one administration login and an operational dashboard.
- Process pull-request events reliably through one PostgreSQL-backed worker.
- Support both shadow and enforce modes, with shadow as the safe default.
- Keep GitHub credentials and administrator credentials in environment variables or mounted secret files.
- Keep the public repository complete and independent of private or provider-specific infrastructure.

## Non-Goals

- Multiple organizations or tenants in one deployment.
- User, team, invitation, role, or permission management.
- GitHub OAuth for administrator login.
- Personal access tokens or user-scoped GitHub API keys.
- Horizontal scaling or multiple supported worker replicas.
- Scheduled SLA checks, reminders, or escalations.
- Scheduled repository compatibility refreshes or historical health snapshots.
- Product analytics, billing, subscriptions, or hosted-service provisioning.
- Kubernetes, Helm, Terraform, or provider-specific deployment support.
- GitLab or Bitbucket support.

GitHub users and teams may still appear as reviewer targets in repository configuration. TriagePilot consumes those identities from GitHub; it does not manage them.

## Supported Deployment

The production Docker Compose stack contains:

- `web`,
- one `worker`,
- `postgres`.

PostgreSQL is the only required supporting service. The deployment includes a named PostgreSQL volume, an explicit migration command, restart policies, a web health check, and documented reverse-proxy, TLS, backup, restore, and upgrade procedures.

The scheduler process is not part of the reduced OSS design. An external queue, cache, metrics service, or identity provider is not required.

## Runtime Components

### Web

`apps/web` owns:

- the administrator login and logout flow,
- signed-cookie authentication for dashboard APIs,
- the static administration UI,
- current configuration and operational status APIs,
- GitHub webhook receipt and signature verification,
- organization validation and durable job insertion,
- the basic `/health` endpoint.

The web process does not perform pull-request routing inside the webhook request.

### Worker

`apps/worker` owns:

- claiming and processing PostgreSQL jobs,
- obtaining GitHub App installation tokens,
- reading repository configuration and pull-request metadata,
- calculating and storing routing decisions,
- applying enforce-mode GitHub actions,
- retrying transient failures,
- recovering its own interrupted jobs,
- updating one current heartbeat,
- periodically removing expired operational data.

Exactly one worker is supported. Multi-worker coordination and throughput scaling are not release requirements.

### PostgreSQL

PostgreSQL stores the GitHub organization installation, repositories, webhook receipt identifiers, jobs, routing decisions, action outcomes, and the current worker heartbeat. It also provides the durable job queue.

### Packages

- `packages/config` parses and validates `.github/triagepilot.yml`.
- `packages/core` contains deterministic risk, ownership, and routing logic without runtime dependencies.
- `packages/db` owns migrations, repositories, and the single-worker job queue.
- `packages/github` owns GitHub App authentication, webhook verification, and API operations.
- `packages/shared` contains small shared constants and types.

There is no scheduler package in the target architecture. SLA logic that exists only for scheduled checks is outside the first OSS release.

## Organization Boundary

Each deployment is configured with one `GITHUB_ORGANIZATION` login and one GitHub App. The App must be installed on that organization and may be granted access to multiple selected repositories.

TriagePilot accepts installation and repository events only when the GitHub account type is `Organization` and its login matches `GITHUB_ORGANIZATION`. Events for personal accounts or other organizations are acknowledged without creating routing work and are logged without storing their payloads.

The database contains at most one active GitHub installation. Supporting another organization requires another TriagePilot deployment.

## Environment Configuration

The required administrator settings are:

- `ADMIN_USERNAME`,
- `ADMIN_PASSWORD`,
- `SESSION_SECRET`.

The required GitHub settings are:

- `GITHUB_ORGANIZATION`,
- `GITHUB_APP_ID`,
- `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_FILE`,
- `GITHUB_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET_FILE`.

The deployment also requires `DATABASE_URL` and `APP_BASE_URL`.

Production startup fails when a required value is missing or still uses a documented placeholder. Secret values are never returned by APIs or written to logs.

GitHub and administrator credentials are read-only at runtime. They are not entered through the dashboard or stored in PostgreSQL. Consequently, the reduced design does not require `APP_ENCRYPTION_KEY`, a database secret store, or setup-secret audit events.

## Administrator Authentication

TriagePilot has exactly one administrator identity. The login screen validates `ADMIN_USERNAME` and `ADMIN_PASSWORD` and then issues a stateless session cookie signed with `SESSION_SECRET`.

The cookie is:

- `HttpOnly`,
- `SameSite=Strict`,
- valid for 12 hours,
- `Secure` when served over HTTPS.

Protected administration routes reject missing, invalid, or expired cookies. Logout removes the browser cookie. Rotating `SESSION_SECRET` invalidates all existing sessions. Login failures use a generic response. Five failed attempts for the same username and source address within 15 minutes cause a 15-minute in-memory lockout; restarting `web` clears this throttle state.

There are no administrator records or sessions in PostgreSQL. Registration, invitations, roles, password resets, OAuth callbacks, account allowlists, and bootstrap-token transitions are not included.

## GitHub Authentication And Permissions

TriagePilot authenticates as the configured GitHub App and creates installation tokens for the configured organization's installation. A personal access token or user API key is neither required nor supported.

The GitHub App uses read-only metadata and contents access plus read-write pull-request, issue, check, and commit-status access. **Commit statuses: Read and write** (`statuses:write`) is required so a ruleset can require `triagepilot/human-review-policy` from the expected TriagePilot App source. It subscribes only to pull-request, installation, and installation-repositories events. Shadow mode performs GitHub reads only. In enforce mode, the existing routing rules may upsert one routing comment, publish one routing check, request up to two selected users or GitHub team reviewers in one call, or submit a policy approval. The public permissions document lists each permission and its purpose.

## Repository Configuration

Each repository may provide `.github/triagepilot.yml`. The configuration contains the routing mode, risk rules, and ownership/reviewer rules. Scheduled SLA configuration is not part of the reduced contract.

The routing contract requests zero human reviewers for low risk, one for medium risk, and one for high risk unless `routing.high_risk_reviewers` is explicitly set to `2`. The high-risk value accepts only `1` or `2`, so one pull request never receives more than two selected human reviewers. Equal-load candidates use a deterministic pull-request-specific ordering. Decisions record the requested count, selected reviewers, and any shortfall when too few eligible reviewers exist.

The repository file is the only per-repository mode control:

```yaml
version: 1
mode: shadow
```

or:

```yaml
version: 1
mode: enforce
```

Missing configuration uses the documented safe defaults in shadow mode. Invalid configuration records a configuration-failure decision without GitHub writes. The worker reads the file from the base SHA carried by the signed pull-request webhook, never from the unmerged head SHA; a pull request therefore cannot enable writes for itself. Pre-upgrade queued jobs that lack the base SHA resolve the current pull request's `base.sha` before the configuration read and never fall back to the head. There is no second mutable repository-mode switch in PostgreSQL or the dashboard.

## Event Flow

1. GitHub sends a subscribed event to `web`.
2. `web` verifies the webhook signature.
3. `web` confirms that the event belongs to `GITHUB_ORGANIZATION`.
4. For a routing-relevant pull-request event, `web` records the GitHub delivery ID, action, and hook ID. It inserts at most one routing job for the repository, pull request, signed base SHA, and head SHA in the same transaction.
5. `web` acknowledges the webhook without waiting for routing.
6. The worker claims the job and creates a GitHub App installation token.
7. The worker reads `.github/triagepilot.yml` from the trusted base SHA, plus changed-file metadata and the pull-request metadata needed by the routing rules. The head SHA remains the target for checks and pull-request actions.
8. Pure domain logic calculates risk, ownership matches, and the routing action.
9. The worker stores the decision and its intended mode.
10. Shadow mode stops without a GitHub write. Before an enforce action sequence, the worker fetches the pull request once and compares its current head SHA with the head SHA from the signed event.
11. A mismatch records a permanent action failure before any check, comment, reviewer, or approval write. A match permits the action sequence; checks target the signed head and policy approvals include it as `commit_id`.

Raw diff contents are not fetched or stored.

## Durable Jobs And Failures

GitHub delivery IDs make webhook insertion idempotent. The durable routing key also deduplicates distinct deliveries for an unchanged repository, pull request, signed base SHA, and head SHA; those deliveries remain recorded as receipts without creating more work. A duplicate delivery returns successfully without creating another job.

The one worker claims queued work transactionally. Transient database or GitHub failures use capped retries with backoff. Authentication failures, permission failures, invalid routing inputs, and exhausted retries become permanent failures visible in the dashboard.

The worker recovers jobs left in a running state after an interrupted process. GitHub writes use stable decision identifiers and idempotent adapter behavior where the GitHub API permits it. The fresh head comparison occurs once immediately before the action sequence; it is not an atomic lock, and the design does not claim that GitHub cannot advance the head after that comparison. The design does not promise parallel worker safety or multi-replica throughput.

## Shadow And Enforce Modes

Shadow mode:

- receives supported webhooks,
- calculates risk and ownership,
- selects the bounded reviewer list or policy action it would apply,
- stores and displays the decision,
- performs no GitHub writes.

Enforce mode performs the configured routing action after the same calculation. The repository configuration at the trusted pull-request base commit must explicitly contain `mode: enforce`; every other state behaves as shadow mode. Configuration changed only in the unmerged head cannot authorize writes. A delayed enforce job whose signed head no longer matches the current pull-request head fails permanently before writes.

Scheduled compatibility state and prerequisite-health gating are not maintained. A GitHub permission or repository-policy rejection is captured as an action failure and shown in the dashboard.

## Administration Dashboard

After login, the dashboard shows:

- the configured organization and non-secret GitHub App status,
- connected repositories from that organization,
- each repository's configuration state and current mode,
- recent routing decisions and action outcomes,
- permanent job or GitHub action failures,
- current worker availability derived from its latest heartbeat.

The dashboard is operational and mostly read-only. It does not contain credential editing, repository mode switches, user management, team management, roles, analytics, SLA views, or billing.

## Data And Retention

The target schema contains only:

- one organization installation,
- repositories,
- webhook receipts,
- jobs,
- routing decisions with action outcomes,
- one current worker heartbeat.

Routing decisions are the product audit trail. A separate general audit-event subsystem, setup state, application secret store, setup-health history, and compatibility state are not part of the reduced design.

The worker performs a small cleanup step at startup and no more than once per day while running:

- webhook receipts and completed jobs are retained for 30 days,
- routing decisions and permanent failures are retained for 90 days.

These periods are fixed for the first OSS release. TriagePilot stores only the pull-request metadata required for routing and never stores diff contents.

Any schema alignment uses a new migration. Existing released migrations are never mutated.

## Operational Behavior

- `/health` reports web-process and database readiness without exposing configuration secrets.
- The worker updates one heartbeat row; a stale heartbeat marks it unavailable in the dashboard.
- Structured application logs go to standard output and standard error for Docker to collect.
- The documented deployment covers TLS termination through a reverse proxy, database backup and restore, and application upgrades with migrations.
- No metrics backend, distributed tracing system, external monitoring integration, or provider-specific runtime is required.

## Public Packaging

The repository includes:

- the AGPL-3.0 license,
- README, security policy, contribution guide, and code of conduct,
- a container-focused environment example,
- Dockerfile and Docker Compose stack,
- migration command,
- GitHub App permission and setup documentation,
- repository configuration reference,
- shadow-to-enforce guidance,
- backup, restore, upgrade, and troubleshooting documentation,
- tests and continuous integration.

Provider-specific deployment adapters, private infrastructure, production secret templates, hosted-service runbooks, and SaaS control-plane code remain outside this repository.

## Verification

Continuous integration verifies:

- frozen dependency installation,
- type checking and linting,
- unit tests,
- PostgreSQL integration tests for migrations, webhook deduplication, job retries, and stale-job recovery,
- production application build,
- migration of an empty database,
- container image build,
- secret scanning and the public/private boundary.

Before a release, a clean clone must build, migrate, boot through the documented Compose path, accept an organization-scoped webhook, and process a shadow-mode pull-request event.

## Acceptance Criteria

The reduced OSS design is complete when:

- the documented Compose deployment starts `web`, one `worker`, and PostgreSQL from a clean clone;
- the configured administrator can log in and log out through the UI;
- missing, invalid, and expired sessions cannot access protected APIs;
- the configured GitHub App can create an installation token for `GITHUB_ORGANIZATION`;
- personal accounts and other organizations cannot create routing work;
- multiple selected repositories in the configured organization can be discovered and processed;
- a duplicate webhook delivery creates exactly one durable job;
- the worker retries transient failures and recovers interrupted jobs after restart;
- shadow mode stores a complete decision without GitHub writes;
- enforce mode applies and records the intended GitHub action;
- missing or invalid repository configuration cannot cause GitHub writes;
- repository configuration changed only in an unmerged pull-request head cannot cause GitHub writes;
- a delayed enforce job with a changed pull-request head records a permanent action failure without GitHub writes;
- recent decisions, action outcomes, and permanent failures are visible in the dashboard;
- stale worker heartbeat state is visible without maintaining historical health snapshots;
- the documented cleanup bounds operational data growth;
- tests, production build, migrations, container build, and secret scans pass.

This specification supersedes the earlier requirements for a scheduler, GitHub OAuth administrator access, database-backed secrets, setup wizard, multi-worker concurrency, scheduled SLA work, compatibility refreshes, historical setup health, and configurable multi-category retention.
