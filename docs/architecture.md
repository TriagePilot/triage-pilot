# Architecture

TriagePilot is a TypeScript monorepo with two portable Node.js processes and PostgreSQL as its only required supporting service. One deployment supports one administrator, one configured GitHub organization, and multiple selected repositories in that organization.

## Processes

- `apps/web` serves the administrator login and operations UI, receives GitHub webhooks, verifies signatures and organization scope, and inserts each webhook receipt and routing or human-review-policy job in one transaction. Its authenticated, workspace-bound operations routes expose reviewer-availability administration and routing recovery. The self-hosted composition root creates the database client, ensures the persisted local workspace, wires the workspace repositories, and supplies GitHub webhook verification, URL parsing, and normalization from `packages/provider-github`.
- `apps/worker` claims jobs from PostgreSQL, creates GitHub App installation tokens, reads repository data, computes and stores routing decisions, applies actions only for explicit enforce configuration, evaluates required human-review policy checks, activates reviewer absences, replays durable replacement finalizers, updates its heartbeat, and performs retention and revoked-connection cleanup. Its self-hosted composition root creates the same persisted local workspace, workspace-bound repositories, GitHub credential provider, GitHub configuration source and adapter factories, and a local no-op platform-event sink for draining the decision outbox.

## Packages

- `packages/contracts` defines provider-neutral workspace, repository, actor, job, and versioned platform-event contracts.
- `packages/config` parses and resolves repository and organization configuration with structured diagnostics.
- `packages/core` contains pure ownership, risk, availability, replacement, and routing logic.
- `packages/application` orchestrates routing, reviewer replacement, durable finalization, human-review policy, and operator recovery through public ports.
- `packages/db` owns schema migrations, workspaces, provider connections, repositories, webhook receipts, routing decisions and action outcomes, availability and replacement state, mutation intents, the platform-event outbox, worker heartbeat, retention, and the PostgreSQL job queue.
- `packages/provider-github` owns GitHub App authentication, webhook verification, GitHub pull-request URL parsing, current-state reads, and provider mutations.
- `packages/ui` owns reusable, host-neutral operations, reviewer-availability, and routing-recovery components.
- `packages/shared` contains small compatibility types and constants used only by the self-hosted applications.

## Request Flow

1. GitHub sends a signed webhook to `apps/web`.
2. The web process accepts only routing-relevant pull-request actions from the configured organization. It records every accepted delivery ID with its action and hook ID, but creates at most one routing job for a repository, pull request, signed base SHA, and head SHA in a transaction.
3. The worker claims the job with PostgreSQL row locking and obtains GitHub App credentials from environment or mounted-file runtime configuration through the self-hosted credential provider. Credentials are not stored in PostgreSQL.
4. The worker reads `.triagepilot.yml`, falling back to `.github/triagepilot.yml`, from the signed base SHA. The self-hosted composition provides no organization configuration source and sets `allowOrganizationEnforce` to `false`, so missing configuration stays in shadow mode and only trusted repository configuration can authorize writes. The head SHA is reserved for checks and pull-request action targeting. An unmerged pull request therefore cannot enable writes by changing its own configuration. For a pre-upgrade queued job without a base SHA, the worker resolves the current pull request's `base.sha` before the configuration read and never substitutes the head SHA.
5. Pure packages parse the configuration and calculate a routing decision without fetching raw diff contents. Low-risk decisions select no human reviewers, medium-risk decisions select one, and high-risk decisions select at most the configured cap of one or two. Reviewer targets are individual GitHub users; team handles are invalid configuration. The pull-request author, active approvers, and reviewers absent at the routing instant are excluded before load lookup. Matching owners are preferred; configured fallbacks supplement only an unfilled quota.
6. The worker stores the selected reviewer list, requested count, any eligibility shortfall, and the original ownership-eligible pool with the intended action. The immutable decision snapshot is the boundary used by later absence replacement; replacement never expands eligibility using newer configuration. The legacy first-reviewer field remains populated for compatibility.
7. Shadow mode stops without a GitHub write. For enforce mode, the worker makes one fresh pull-request read immediately before beginning the action sequence and compares the current head SHA with the signed event head SHA. A mismatch becomes a permanent action failure before any check, label, comment, reviewer, or approval write. A matching action synchronizes exactly one managed `triagepilot:risk-low`, `triagepilot:risk-medium`, or `triagepilot:risk-high` label while leaving other labels untouched.
8. When the comparison matches, checks target that head SHA and policy approvals include it as `commit_id`; the worker applies the remaining pull-request actions and records the outcome. This preflight comparison is not an atomic lock on the pull request, so the head can still change after the comparison.

In enforce mode, TriagePilot also creates `triagepilot/human-review-policy` on the routed head. It succeeds immediately for a no-human route, stays in progress until the route's required number of individual human approvals is present, and fails for an eligibility, configuration, authorization, or permanent evaluation failure. Reviewer selection remains a request mechanism, not a required approval cohort: active individual approvals already present on the pull request count even when they predate TriagePilot. A human-review routing action creates a durable evaluation job immediately, and a `pull_request_review` webhook creates one for each later review event; the worker re-evaluates the active GitHub review state. Reviewer replacement never lowers this required count. The policy check is separate from the routing action outcome and is displayed separately in the dashboard.

## Availability and Recovery Flows

Reviewer availability is centralized workspace operational state, outside repository configuration. The web host converts validated local wall times in the workspace's IANA timezone into UTC instants. Each create or edit transaction stores a revision and its revision-keyed delayed activation job together. Cancellation increments the revision so older queued jobs become successful no-ops.

At activation, the application use case reads current provider state, plans against the original decision snapshot, prepares a durable provider-mutation intent, and finally locks and revalidates the job lease, absence revision, provider connection, routed head, approval state, active cohort, and candidate availability. Enforce-mode GitHub writes are idempotent; shadow mode runs selection and persistence with no provider write. Replacement state and the corresponding `ReviewerReplacementEventV1` are persisted atomically. If a provider effect succeeds before persistence or policy finalization fails, the job payload carries a mapped finalizer recovery that replays finalization without selecting or mutating again.

Authenticated routing recovery accepts either a workspace-scoped decision or a GitHub pull-request URL handled by the self-hosted provider adapter. It reads the current open/base/head/draft state, creates a fresh lifecycle-aware operator routing identity, and queues an ordinary routing job. The worker resolves trusted repository configuration at execution time; recovery neither synthesizes a webhook receipt nor reuses the historical decision's delivery identity.

GitHub installation deletion first records a permanent scoped revocation and marks any existing provider connection `revoked`. All routing and mutation authority checks fail closed from that point. Physical cascading deletion is deferred to retryable worker maintenance, avoiding lock inversion with in-flight availability work. A delete-before-create tombstone also prevents a delayed webhook from activating the same external connection ID; a genuine reconnect requires a new immutable external ID.

PostgreSQL contains the local workspace, provider connection and revocation records, repositories, webhook receipts, jobs, routing decisions with action outcomes, availability schedules, replacement history and mutation intents, the platform-event outbox, and one current worker heartbeat. Administrator and GitHub credentials remain in environment variables or mounted files and are not stored in PostgreSQL.

Routing decisions, action outcomes, and reviewer replacement history are the product audit record; there is no separate general audit-event subsystem. Versioned routing-decision and reviewer-replacement events are staged in PostgreSQL atomically with the state they describe and drained from the platform-event outbox by the worker. Event identity is workspace-scoped and safe for at-least-once delivery. The self-hosted runtime uses a no-op local sink, so analytics delivery failures cannot block routing or maintenance.

Provider-specific deployment adapters and private operational material are intentionally outside this repository.

## Phase 0 Release Evidence Contract

A release is one annotated `vX.Y.Z` tag and the exact commit that tag targets. Its public contract is seven registry packages (`contracts`, `config`, `core`, `application`, `db`, `provider-github`, and `ui`) plus the OCI image; consumers use those artifacts rather than an OSS source checkout. The protected tag workflow resolves the tag target commit, derives one artifact-publication timestamp and its second-anniversary Apache 2.0 effective timestamp, and builds every package and image from those inputs.

The tag workflow's `artifacts/release-manifest.json` and `artifacts/checksums.txt` are authoritative. They record the synchronized version, tag-target commit, highest public migration, `FSL-1.1-Apache-2.0` identifier, timestamps, every package SHA-256 digest, and the OCI digest with matching annotations. Public Git history remains the source-availability record; artifact timestamps record artifact provenance.

For this candidate, the highest public migration is `0010_provider_connection_preemptive_revocations.sql`. The immutable migration history includes both `0005_reviewer_availability.sql` and `0005_workspace_scope.sql`; the shared numeric prefix is valid because migration identity is the complete filename. Release-manifest generation refuses evidence that omits either historical lineage.

Pre-tag dry runs prove the release gate and artifact contract but do not attest future published bytes: their timestamps and digests are ephemeral and remain release-review evidence rather than public release values. The canonical parallel `pnpm test` gate verifies artifact packaging in a disposable source workspace, so it cannot remove shared `packages/*/dist` entrypoints. Review and explicit release approval are still required before a tag is created.
