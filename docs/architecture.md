# Architecture

TriagePilot is a TypeScript monorepo with two portable Node.js processes and PostgreSQL as its only required supporting service. One deployment supports one administrator, one configured GitHub organization, and multiple selected repositories in that organization.

## Processes

- `apps/web` serves the administrator login and read-only operations UI, receives GitHub webhooks, verifies signatures and organization scope, and inserts each webhook receipt and routing or human-review-policy job in one transaction. Its self-hosted composition root creates the database client, ensures the persisted local workspace, wires the workspace repositories, and supplies GitHub webhook verification and normalization from `packages/provider-github`.
- `apps/worker` claims jobs from PostgreSQL, creates GitHub App installation tokens, reads repository data, computes and stores routing decisions, applies actions only for explicit enforce configuration, evaluates required human-review policy checks, recovers interrupted jobs, updates its heartbeat, and removes expired data. Its self-hosted composition root creates the same persisted local workspace, workspace-bound repositories, GitHub credential provider, GitHub configuration source and adapter factories, and a local no-op decision-event sink for draining the decision outbox.

## Packages

- `packages/config` parses and resolves repository and organization configuration with structured diagnostics.
- `packages/core` contains pure ownership, risk, and routing logic.
- `packages/db` owns schema migrations, installations, repositories, webhook receipts, routing decisions and action outcomes, the worker heartbeat, retention, and the PostgreSQL job queue.
- `packages/provider-github` owns GitHub App authentication, webhook verification, and API operations.
- `packages/shared` contains small cross-package types and constants.

## Request Flow

1. GitHub sends a signed webhook to `apps/web`.
2. The web process accepts only routing-relevant pull-request actions from the configured organization. It records every accepted delivery ID with its action and hook ID, but creates at most one routing job for a repository, pull request, signed base SHA, and head SHA in a transaction.
3. The worker claims the job with PostgreSQL row locking and obtains GitHub App credentials from environment or mounted-file runtime configuration through the self-hosted credential provider. Credentials are not stored in PostgreSQL.
4. The worker reads `.triagepilot.yml`, falling back to `.github/triagepilot.yml`, from the signed base SHA. The self-hosted composition provides no organization configuration source and sets `allowOrganizationEnforce` to `false`, so missing configuration stays in shadow mode and only trusted repository configuration can authorize writes. The head SHA is reserved for checks and pull-request action targeting. An unmerged pull request therefore cannot enable writes by changing its own configuration. For a pre-upgrade queued job without a base SHA, the worker resolves the current pull request's `base.sha` before the configuration read and never substitutes the head SHA.
5. Pure packages parse the configuration and calculate a routing decision without fetching raw diff contents. Low-risk decisions select no human reviewers, medium-risk decisions select one, and high-risk decisions select at most the configured cap of one or two. Reviewer targets are individual GitHub users; team handles are invalid configuration.
6. The worker stores the selected reviewer list, requested count, and any eligibility shortfall with the intended action. The legacy first-reviewer field remains populated for compatibility.
7. Shadow mode stops without a GitHub write. For enforce mode, the worker makes one fresh pull-request read immediately before beginning the action sequence and compares the current head SHA with the signed event head SHA. A mismatch becomes a permanent action failure before any check, label, comment, reviewer, or approval write. A matching action synchronizes exactly one managed `triagepilot:risk-low`, `triagepilot:risk-medium`, or `triagepilot:risk-high` label while leaving other labels untouched.
8. When the comparison matches, checks target that head SHA and policy approvals include it as `commit_id`; the worker applies the remaining pull-request actions and records the outcome. This preflight comparison is not an atomic lock on the pull request, so the head can still change after the comparison.

In enforce mode, TriagePilot also creates `triagepilot/human-review-policy` on the routed head. It succeeds immediately for a no-human route, stays in progress until the route's required number of individual human approvals is present, and fails for an eligibility, configuration, authorization, or permanent evaluation failure. Reviewer selection remains a request mechanism, not a required approval cohort: active individual approvals already present on the pull request count even when they predate TriagePilot. A human-review routing action creates a durable evaluation job immediately, and a `pull_request_review` webhook creates one for each later review event; the worker re-evaluates the active GitHub review state. The policy check is separate from the routing action outcome and is displayed separately in the dashboard.

PostgreSQL contains the organization installation, repositories, webhook receipts, jobs, routing decisions with action outcomes, and one current worker heartbeat. Administrator and GitHub credentials remain in environment variables or mounted files and are not stored in PostgreSQL.

Routing decisions and action outcomes are the product audit record; there is no separate general audit-event subsystem. Decision events are staged in PostgreSQL with the routing decision and drained from the local decision outbox by the worker. The self-hosted runtime uses a no-op local sink, so analytics delivery failures cannot block routing or maintenance.

Provider-specific deployment adapters and private operational material are intentionally outside this repository.

## Phase 0 Release-Candidate Boundary

The Phase 0 candidate is built from public Git commit `52d6761344bb8dca71cc4a75b5e3bbea5db437a7` at version `0.1.0`. Its public contract is seven registry packages (`contracts`, `config`, `core`, `application`, `db`, `provider-github`, and `ui`) plus the OCI image; consumers must use those artifacts rather than an OSS source checkout. The release manifest binds every package and the image to that same version and commit, the public migration `0006_decision_outbox.sql`, the `FSL-1.1-Apache-2.0` identifier, one artifact timestamp, and its second-anniversary Apache 2.0 effective timestamp. Public Git history remains the source-availability record; artifact timestamps record only artifact provenance.

Candidate artifact generation on 2026-08-28 produced `publishedAt` `2026-08-28T12:27:53.000Z` and `futureLicenseEffectiveAt` `2028-08-28T12:27:53.000Z`. The OCI manifest digest was `sha256:0f213155389ddcb8ca28d78f7476364a0f4ac3a74daf7b7b773131fef3aa38bf`; its manifest annotations carry the same version, commit, license, and timestamps. A clean detached checkout built successfully with `pnpm install --offline --frozen-lockfile` and `pnpm build`, with no sibling private-product directory present. A temporary external consumer installed the seven packed artifacts from an artifact registry, compiled declarations, imported every package, and had no `workspace:`, `link:`, `file:`, Git, or source-path dependency in its lockfile. The built web image returned a healthy `/health` response against a disposable migrated PostgreSQL database.

This evidence does not authorize a tag. The canonical parallel `pnpm test` gate currently has a test-isolation race: `test/package-artifacts.test.ts` invokes `pnpm build` while other suites resolve shared `packages/*/dist` artifacts. The serial full suite passes, but release approval must wait for the canonical gate to be made deterministic and for explicit release approval.
