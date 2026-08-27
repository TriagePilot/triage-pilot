# Reviewer availability design

## Purpose

Allow the administrator to record planned, organization-wide reviewer absences in the operations UI. While a person is absent, TriagePilot excludes that person from new reviewer selection. If their review is still required on an open pull request, TriagePilot replaces them automatically when the absence begins.

The feature is deliberately central rather than repository-configured. Vacation schedules change frequently and must not require a configuration pull request in every repository.

## Scope and constraints

- One deployment serves one configured GitHub organization and one administrator.
- Availability is an operations setting, not a `.github/triagepilot.yml` setting.
- Repository ownership rules, fallback rules, risk scoring, reviewer caps, and branch exclusions are unchanged.
- Shadow mode remains GitHub-write-free. It may persist availability and simulated re-routing outcomes.
- Enforce mode is the only mode permitted to change GitHub review requests or the human-review policy check.
- The implementation uses the existing PostgreSQL queue's delayed `run_at` jobs. It does not add a periodic scheduler or a separate service.

## Administrator experience

The authenticated operations UI gains an **Availability** area.

It shows active and upcoming absences with:

- the individual GitHub handle;
- start and end date-times in the organization timezone;
- active, upcoming, ended, or cancelled status; and
- any pull requests affected by a completed replacement attempt.

The administrator can create, edit, and cancel an absence. A form accepts an individual `@handle`, a start date-time, and an end date-time. Handles use the same individual-user syntax as routing configuration. The end must be strictly after the start, and overlapping absences for the same normalized handle are rejected.

The UI also manages one persisted organization timezone. It defaults to `UTC` and uses an IANA timezone identifier. Inputs and displays use this timezone; PostgreSQL persists the corresponding absolute UTC instants. Changing the timezone changes only presentation, never a saved absence instant.

## Data model

A new migration adds:

- an organization-settings singleton containing the IANA timezone;
- `reviewer_absences`, with normalized reviewer handle, UTC start and end instants, lifecycle status, revision, and timestamps; and
- `reviewer_replacements`, an append-only, decision-scoped history of an absence-driven replacement attempt, including the unavailable reviewer, replacement when one exists, outcome, reason, and timestamps.

The replacement table is feature-specific audit data, not a general audit-event subsystem. Routing decisions remain the primary audit record. The current selected-reviewer list on a decision represents the active cohort; its replacement-history rows explain how that cohort changed.

Creating, editing, or cancelling an absence updates its revision and queues the relevant delayed activation job in the same transaction. Jobs do not need to be deleted when a schedule changes: each job carries the absence ID and expected revision, and becomes a no-op if it is stale or cancelled.

## Availability selection

All reviewer candidate selection receives the current time and excludes every normalized reviewer whose absence interval satisfies `start_at <= now < end_at`.

This filter applies to new routing decisions before load-based selection. Existing routing rules still determine the candidate pool. An absence never makes a person a candidate, broadens direct ownership to fallback ownership, or otherwise changes repository configuration semantics.

When an absence ends, the time-based filter naturally stops excluding that person. No end job or retroactive re-routing is needed.

## Planned-absence activation and re-routing

At an absence's start instant, the delayed worker job processes the current revision and finds only routing decisions that are:

- enforce-mode decisions with an open pull request and an unsatisfied human-review policy cohort;
- for the current routed head SHA; and
- selected for the absent reviewer, where that reviewer has not approved the current head.

The job does not re-score the pull request and does not reread or reinterpret later repository configuration. It reuses the original decision's stored ownership-eligible reviewer pool, then excludes the PR author, people who already approved the current head, and all currently absent people. It selects a replacement using the existing load-aware, deterministic selection rule.

A reviewer who has approved the current head is never replaced. A reviewer with an outstanding request or a changes-requested review is eligible for replacement. A decision whose policy check has succeeded is not changed.

Before an enforce-mode mutation, the worker verifies that the pull request is still open and on the routed head. If it is not, the job stops without mutation; the normal pull-request webhook creates the appropriate new decision for the new head.

On a valid replacement, the enforce-mode action sequence is idempotent:

1. Confirm current GitHub review and review-request state.
2. Remove the unavailable person's outstanding review request.
3. Request the selected replacement.
4. Persist the replacement history and replace the absent person in the decision's active cohort.
5. Re-evaluate and update `triagepilot/human-review-policy` for that cohort.

The GitHub adapter must tolerate a retry after a partially completed sequence by deriving the next safe action from current GitHub state. A transient failure uses normal durable-job retry behavior. A permanent failure is recorded and leaves the required policy blocked rather than weakening it.

If no eligible replacement exists, TriagePilot records a `no_replacement_available` outcome and leaves the required reviewer count unchanged. In enforce mode it updates the policy check to `failure` with that explicit reason; it does not silently reduce the cohort, request an owner outside the original eligibility pool, or allow the pull request to proceed with fewer human approvals.

In shadow mode, activation evaluates the same criteria and persists a simulated replacement outcome, but makes no GitHub API write of any kind.

## Process boundaries

- `apps/web` owns authenticated availability and organization-timezone API routes plus the operations UI.
- `packages/db` owns migrations, validated persistence operations, transactional job enqueueing, and replacement-history queries.
- `packages/core` owns pure time-aware candidate filtering and replacement selection.
- `apps/worker` owns delayed-job dispatch, open/head/review verification, re-routing orchestration, retries, and policy re-evaluation.
- `packages/github` owns GitHub review-request inspection/removal/request operations required for idempotent replacement.

No repository configuration parser changes are needed. Documentation must describe availability as centrally administered and explain that it affects future routing and outstanding unapproved cohorts only.

## Error handling and observability

Invalid form data receives a clear API validation response. A stale job, cancelled absence, already-approved reviewer, closed pull request, changed head, or already-succeeded policy check is a successful no-op, not an error.

Replacement history must show the result of every attempted activation, including skipped and no-replacement cases. The operations UI exposes those records alongside the relevant absence so an administrator can understand why a reviewer was or was not replaced without reading worker logs.

## Verification

Tests must cover:

- absence validation, normalized-handle overlap rejection, organization-timezone conversion, and DST boundaries;
- transactional schedule creation/edit/cancellation and revision-guarded delayed jobs;
- active-absence filtering for new routing without changing unrelated ownership behavior;
- replacement only when the absent reviewer has not approved the current head;
- exclusion of authors, approved reviewers, and concurrently absent reviewers;
- preservation of the original eligible pool and required reviewer count;
- no-replacement policy blocking;
- changed-head, closed-PR, completed-policy, stale-job, and cancellation no-ops;
- idempotent GitHub action ordering and retry after a partial mutation;
- shadow-mode persistence with zero GitHub writes; and
- authenticated UI/API behavior and display of replacement history.

The implementation must run the repository checks required by `AGENTS.md`: `pnpm check`, `pnpm test`, `pnpm build`, and `docker build .`.
