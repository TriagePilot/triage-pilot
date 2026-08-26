# Architecture

TriagePilot is a TypeScript monorepo with two portable Node.js processes and PostgreSQL as its only required supporting service. One deployment supports one administrator, one configured GitHub organization, and multiple selected repositories in that organization.

## Processes

- `apps/web` serves the administrator login and read-only operations UI, receives GitHub webhooks, verifies signatures and organization scope, and inserts each webhook receipt and routing or human-review-policy job in one transaction.
- `apps/worker` claims jobs from PostgreSQL, creates GitHub App installation tokens, reads repository data, computes and stores routing decisions, applies actions only for explicit enforce configuration, evaluates required human-review policy checks, recovers interrupted jobs, updates its heartbeat, and removes expired data.

## Packages

- `packages/config` parses `.github/triagepilot.yml` and returns structured diagnostics.
- `packages/core` contains pure ownership, risk, and routing logic.
- `packages/db` owns schema migrations, installations, repositories, webhook receipts, routing decisions and action outcomes, the worker heartbeat, retention, and the PostgreSQL job queue.
- `packages/github` owns GitHub App authentication, webhook verification, and API operations.
- `packages/shared` contains small cross-package types and constants.

## Request Flow

1. GitHub sends a signed webhook to `apps/web`.
2. The web process accepts only routing-relevant pull-request actions from the configured organization. It records every accepted delivery ID with its action and hook ID, but creates at most one routing job for a repository, pull request, signed base SHA, and head SHA in a transaction.
3. The worker claims the job with PostgreSQL row locking and obtains an installation token.
4. The worker reads `.github/triagepilot.yml` from the signed base SHA, while the head SHA is reserved for checks and pull-request action targeting. An unmerged pull request therefore cannot enable writes by changing its own configuration. For a pre-upgrade queued job without a base SHA, the worker resolves the current pull request's `base.sha` before the configuration read and never substitutes the head SHA.
5. Pure packages parse the configuration and calculate a routing decision without fetching raw diff contents. Low-risk decisions select no human reviewers, medium-risk decisions select one, and high-risk decisions select at most the configured cap of one or two. Reviewer targets are individual GitHub users; team handles are invalid configuration.
6. The worker stores the selected reviewer list, requested count, and any eligibility shortfall with the intended action. The legacy first-reviewer field remains populated for compatibility.
7. Shadow mode stops without a GitHub write. For enforce mode, the worker makes one fresh pull-request read immediately before beginning the action sequence and compares the current head SHA with the signed event head SHA. A mismatch becomes a permanent action failure before any check, label, comment, reviewer, or approval write. A matching action synchronizes exactly one managed `triagepilot:risk-low`, `triagepilot:risk-medium`, or `triagepilot:risk-high` label while leaving other labels untouched.
8. When the comparison matches, checks target that head SHA and policy approvals include it as `commit_id`; the worker applies the remaining pull-request actions and records the outcome. This preflight comparison is not an atomic lock on the pull request, so the head can still change after the comparison.

In enforce mode, TriagePilot also creates `triagepilot/human-review-policy` on the routed head. It succeeds immediately for a no-human route, stays in progress until the route's required number of individual human approvals is present, and fails for an eligibility, configuration, authorization, or permanent evaluation failure. Reviewer selection remains a request mechanism, not a required approval cohort: active individual approvals already present on the pull request count even when they predate TriagePilot. A human-review routing action creates a durable evaluation job immediately, and a `pull_request_review` webhook creates one for each later review event; the worker re-evaluates the active GitHub review state. The policy check is separate from the routing action outcome and is displayed separately in the dashboard.

PostgreSQL contains the organization installation, repositories, webhook receipts, jobs, routing decisions with action outcomes, and one current worker heartbeat. Administrator and GitHub credentials remain in environment variables or mounted files and are not stored in PostgreSQL.

Routing decisions and action outcomes are the product audit record; there is no separate general audit-event subsystem.

Provider-specific deployment adapters and private operational material are intentionally outside this repository.
