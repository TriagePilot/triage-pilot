# Task 6 Report: Add Workspace-Scoped Availability Persistence

## Final status

Task 6 and both review-fix rounds are implemented in the local `commercial-saas-phase-0` worktree. The implementation is provider-neutral, workspace-bound, transactionally stages current events, and keeps historical replay fail-closed. Historical migrations `0001` through `0006` are unchanged. Migration `0007_workspace_reviewer_availability.sql` is intentionally extended by Task 6 to add durable provider change-request identity to routing decisions.

No push, pull request, tag, publication, dependency change, commercial/tenant API, or persistent database migration was performed.

## Repository API

`createWorkspaceReviewerAvailability(db, workspaceId)` returns a repository permanently bound to one workspace. Its boundary provides:

- `readSettings` and `updateTimezone` for the workspace operational timezone. UTC is the default; writes accept UTC or a canonical supported IANA timezone.
- `listAbsences`, `scheduleAbsence`, `reviseAbsence`, and `cancelAbsence` for revisioned provider-qualified absence records.
- `findActiveAbsences` using the half-open predicate `start_at <= at AND end_at > at`.
- `loadActivation(absenceId, revision)` for only the exact current scheduled revision on an active provider connection.
- `listPendingFinalizers({ absenceId, absenceRevision })` as an independent recovery boundary that survives absence revision, cancellation, and connection suspension.
- `listReplacementHistory`, `persistReplacement`, and `updateReplacementState` for durable history and replay-safe finalization.

`findReviewerReplacementCandidates` is workspace/provider/connection scoped. It selects the latest current decision for each durable repository/change-request pair, requires a non-null durable change-request identity, preserves exact opaque provider actor identifiers, derives the immutable preferred/eligible pools and requested reviewer count from decision details, and excludes every decision already recorded for the same absence revision regardless of replacement outcome or finalizer state.

## Schema and change-request identity

Migration `0007_workspace_reviewer_availability.sql` adds nullable `routing_decisions.change_request_id text`. Nullability exists only for upgrade compatibility:

- Fresh/current writes require a non-empty opaque `DecisionInput.changeRequestId` at runtime and preserve the exact provider-owned value.
- Current-Phase history backfills the exact value from its schema-v1 routing-decision outbox payload.
- Current-main history without an authoritative provider external ID remains null. The migration never guesses from `pull_number`.
- A legacy null decision cannot produce a new versioned routing or reviewer-replacement event. A later current reroute can create a fully identified decision.

The worker routing composition passes the application contract’s exact `changeRequestId`. DB integration fixtures also supply it explicitly so runtime omission cannot be hidden by TypeScript-only construction.

## Transaction, locking, and event model

Scheduling, revision, cancellation, replacement persistence, cohort mutation, and event staging run in database transactions. Schedule/revise/cancel enqueue revision-specific activation jobs in the same transaction. Revision and cancellation lock the current absence with `FOR UPDATE`, validate the expected revision, and increment once. Provider-neutral transaction advisory locks serialize overlapping actor mutations.

Fresh replacement persistence locks the absence and routing decision with `FOR UPDATE`, then revalidates:

- workspace, provider, and provider-connection scope;
- active connection and exact absence actor/revision/status/half-open window;
- routed head, selected cohort, immutable eligibility, and terminal policy state;
- replacement availability under the same actor advisory-lock discipline;
- exact durable repository and change-request identity for `ReviewerReplacementEventV1`.

History insertion, optional cohort replacement, and reviewer-replacement outbox staging are atomic. A forced outbox failure rolls back both history and cohort changes. A controlled concurrent test observes final persistence blocked on the exact revision transaction ID and then rejected after the competing revision commits.

`persistDecisionWithEvent` first applies the routing-key upsert, then reads and locks the effective persisted decision row. This matters for terminal retries because succeeded fields are preserved rather than replaced by the new calculation. Before staging, the callback event must match the effective row’s decision ID, workspace, provider, external repository ID, provider change-request ID, routing key, mode, action, risk score, selected actors, and effective configuration hash. Missing/blank runtime change-request IDs and any event mismatch reject the transaction. Existing outbox exact-retry conflict checks remain the final event-ID/payload guard.

## Historical replacement replay

Fresh replacement plus outbox event is atomic, so an existing `reviewer_replacements` row with no source-bound outbox event is historical. Its exact retry returns the immutable history but remains eventless; caller-supplied repository/change-request identity is never staged. This is deliberately fail-closed because no complete persisted event exists to authenticate the payload.

An existing row with one persisted outbox event follows the current exact-retry path: history fields must match, the stored event ID/type/version/time/full payload must match, and idempotent staging returns the same source-bound event. A different event or source is rejected. This distinction needs no provider-specific result vocabulary: `inserted: false` identifies replay, while durable outbox presence determines whether there is an authenticated event to restage.

## Replacement state vocabulary

- `finalizer_pending`: provider effects may have completed but the mapped finalizer still requires replay; `lastError` may hold the latest transient error.
- `completed`: finalization is complete and `lastError` is null.
- `permanent_failure`: recovery is terminal and requires a non-empty `lastError` for operations visibility.

Transitions are row-locked and idempotent. Only `finalizer_pending` may move to a terminal state. Pending finalizers are discovered separately from revision-specific activation, so administrative changes cannot strand committed work and old recovery cannot leak into a new activation.

## TDD evidence

### Initial implementation

The original availability/candidate/isolation RED failed with the missing repository and candidate-discovery boundaries. The initial implementation then passed the required three suites and established timezone, revision, half-open lookup, isolation, immutable pool, final persistence, event rollback, and state-transition coverage.

### Fix round 1

Tests were added before production/migration changes for independent finalizer recovery, exact opaque actor IDs, locked absence-actor binding, processed-decision exclusion, durable change-request identity, current-main/current-Phase upgrade histories, and controlled concurrency. The combined RED exited 1 with 4 failed files, 1 passed file, 21 failed tests, and 18 passed tests. Final round-1 verification passed root integration with 10 files and 73 tests.

### Fix round 2

Before production changes, focused availability/outbox regressions exited 1 with 5 failures and 29 passes:

- a historical no-outbox replacement accepted and staged a forged retry event;
- missing/blank `DecisionInput.changeRequestId` reached persistence;
- repository and change-request event mismatches committed;
- terminal retry validation occurred only later as an outbox payload conflict rather than against the effective persisted decision.

After the minimal fixes:

- availability + decisions + outbox: 3 files, 42 tests passed;
- availability + decisions + outbox + upgrade + schema: 5 files, 47 tests passed;
- root `pnpm test:integration`: 10 files, 78 tests passed;
- `pnpm --filter @triagepilot/db check`: passed;
- rebuilt `@triagepilot/db`, then `pnpm --filter @triagepilot/worker check`: passed;
- `git diff --check`: passed;
- historical migrations `0001` through `0006` remain unchanged;
- post-run inspection found zero `triagepilot_test_%` databases.

All PostgreSQL integration runs used the UUID-named disposable database helper. The persistent `triagepilot` database was not migrated or mutated.

## Files

- `packages/db/src/availability.ts`: workspace repository, revision/lock validation, replay-safe history, and replacement event staging.
- `packages/db/src/decisions.ts`: runtime decision validation, effective-row event binding, candidate discovery, and immutable actor-pool parsing.
- `packages/db/src/kysely.ts`: nullable upgrade-safe `change_request_id` table typing.
- `packages/db/migrations/0007_workspace_reviewer_availability.sql`: durable change-request column and trustworthy Phase-event backfill.
- `apps/worker/src/runtime-services.ts`: exact application change-request identity composition.
- `package.json`: availability suite included in root integration.
- DB availability, decisions, outbox, schema, upgrade, and isolation tests: persistence, migration, replay, rollback, identity, concurrency, and scope coverage.

## Residual concerns

The only intentional compatibility limitation is legacy routing history with no authoritative provider change-request ID. Such rows remain readable but cannot become candidates for newly versioned replacement events or stage new routing events. This is safer than inventing identity from a numeric request number.

Historical replacement rows without a source-bound outbox event remain permanently eventless on retry. Their history and finalizer state stay recoverable, but publication cannot be reconstructed from caller input. No blocker remains.
