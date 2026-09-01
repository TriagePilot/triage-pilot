# Task 6 Report: Add Workspace-Scoped Availability Persistence

## Status and commit

Implemented for the Task 6 commit `feat: persist reviewer absence schedules` (the commit containing this report). No push, pull request, tag, publish, dependency change, historical migration edit, commercial code, or persistent database migration was performed.

## TDD RED

The new availability suite and the candidate-discovery/workspace-isolation assertions were written before production code. The required RED command used `TEST_DATABASE_URL` mapped to the loopback-published local PostgreSQL container; every test database was created and removed by the repository's UUID-named disposable database helper:

```text
pnpm vitest run packages/db/test/availability.integration.test.ts packages/db/test/decisions.integration.test.ts packages/db/test/workspace-isolation.integration.test.ts
```

Result: exit 1; 3 files failed, with 11 failed and 14 passed tests. The feature-specific failures were the missing `createWorkspaceReviewerAvailability` repository factory and missing `findReviewerReplacementCandidates` query.

Two self-review regressions were also captured test-first:

- A focused pending-finalizer test initially failed because an activation for revision 2 received revision 1 recovery history. Filtering pending finalizers by absence revision made the focused test pass.
- A focused exact-retry test exited 1 because a persisted replacement replay with a different event ID staged a second platform event. The repository now checks the source-bound persisted outbox event before retry staging; the focused test then passed.

## GREEN and verification

Final required command:

```text
pnpm vitest run packages/db/test/availability.integration.test.ts packages/db/test/decisions.integration.test.ts packages/db/test/workspace-isolation.integration.test.ts
```

Result: exit 0; 3 files and 25 tests passed.

Broader verification:

- `pnpm test:integration`: exit 0; 9 files and 55 tests passed.
- `pnpm --filter @triagepilot/db check`: exit 0; TypeScript completed without errors.
- `git diff --check`: passed.
- Production boundary search found no GitHub, commercial, or tenant literals in the new/modified generic DB modules.
- No migration file changed.
- Post-run PostgreSQL inspection found zero `triagepilot_test_%` databases.
- The persistent `triagepilot` database was neither migrated nor mutated.

## Repository API

`createWorkspaceReviewerAvailability(db, workspaceId)` returns a repository permanently bound to one workspace. Its public boundary implements the planned settings, absence, active-window, activation, and history methods, plus the minimal final-persistence methods required by Tasks 8 and 9:

- `readSettings` and `updateTimezone` maintain one operational timezone per workspace. UTC is the default; writes require UTC or a canonical supported IANA timezone identifier.
- `listAbsences`, `scheduleAbsence`, `reviseAbsence`, and `cancelAbsence` expose normalized provider-neutral actor records. Every mutation requires a provider-qualified active connection in the bound workspace.
- `findActiveAbsences` resolves the active provider from the bound connection and uses the half-open predicate `start_at <= at AND end_at > at`.
- `loadActivation(absenceId, revision)` accepts only the exact current scheduled revision on an active connection and returns its immutable decision candidates plus only same-revision pending finalizers. The application Clock in Task 8 remains responsible for deciding whether the returned half-open window is active at execution time; final persistence independently revalidates the window at `completedAt`.
- `listReplacementHistory` remains workspace-bound and can optionally filter by absence.
- `persistReplacement` atomically records history, conditionally replaces the durable cohort, and stages the matching `ReviewerReplacementEventV1`.
- `updateReplacementState` exposes the explicit replay-safe finalizer transition boundary.

`findReviewerReplacementCandidates` is workspace/provider/connection scoped and requires an active connection. It selects only the latest persisted decision for each repository/change-request number whose current cohort contains the normalized unavailable actor. It rejects malformed snapshots and derives `originalPreferredActors`, `originalEligibleActors`, and the 1-or-2 requested reviewer count solely from immutable decision details. A pre-preference snapshot without `preferredReviewers` uses the persisted eligible pool as its legacy preferred pool; current configuration is never consulted.

## Transaction and locking model

- Scheduling, revision, cancellation, replacement persistence, cohort mutation, and event staging run inside database transactions.
- Activation jobs use `reviewer-absence:<absence-id>:revision:<revision>` and store the exact public job payload. Schedule and edit jobs run at the later of the requested start and transaction time; cancellation increments the revision and enqueues an immediate revision-specific no-op activation. Existing stale jobs remain durable and are invalidated by revision/status checks.
- Edits and cancellation lock the current absence with `FOR UPDATE`, check the caller's expected revision, increment it exactly once, and retain the old jobs for observable retry semantics.
- Provider-neutral transaction-scoped advisory locks serialize mutations for the same workspace/provider/connection/actor. Actor keys are deduplicated and sorted before locking, closing insert-versus-final-availability races while limiting lock scope.
- Final replacement persistence locks the absence and routing decision with `FOR UPDATE`. It rechecks active connection scope, exact absence revision/status/half-open time, routed head, cohort membership, immutable eligibility, repository event identity, terminal policy state for cohort replacement, duplicate cohort membership, and candidate absence before any insert or cohort update.
- The scoped replacement unique key is the concurrency arbiter for one absence revision and decision. A persisted exact retry is accepted even if the absence was later revised/cancelled or its connection suspended, because it replays already-committed history rather than rerunning selection. Its history fields and source-bound outbox event must match exactly; differing retries fail without adding another event.
- Replacement insertion, cohort mutation, and outbox staging share one transaction. A trigger-forced outbox failure proves that history and cohort changes both roll back.

## Replacement state vocabulary

Task 4 deliberately left the SQL column open as text. This task defines the smallest explicit repository vocabulary needed by later orchestration:

- `finalizer_pending`: provider effects may have completed, but the mapped final database finalizer still requires replay; `lastError` may record the latest transient failure.
- `completed`: finalization is complete and `lastError` must be null.
- `permanent_failure`: recovery is terminal and a non-empty `lastError` is required for operations visibility.

Transitions are row-locked and idempotent. Only a `finalizer_pending` row may change state (or update its retry error); it may become `completed` or `permanent_failure`. An exact terminal replay returns the existing row, while a stale expected state returns null. Migration `0007` was not edited; historical rows continue to map to `completed` through its existing default.

## Files

- `packages/db/src/availability.ts`: workspace repository, validation, revisioned job enqueue, activation loading, final persistence, history, and finalizer states.
- `packages/db/src/decisions.ts`: scoped replacement-candidate discovery and strict immutable snapshot parsing.
- `packages/db/src/index.ts`: provider-neutral public exports.
- `packages/db/test/availability.integration.test.ts`: timezone, enqueue rollback, revision/cancel behavior, active lookup, final races, history/state/event idempotency, and rollback coverage.
- `packages/db/test/decisions.integration.test.ts`: latest candidate discovery and immutable pool/quota derivation.
- `packages/db/test/workspace-isolation.integration.test.ts`: repository binding across workspaces, providers, connections, and inactive connections.

## Self-review and concerns

Workspace identity appears in every repository read and mutation; provider and provider-connection identity appear wherever absence or replacement state is provider-scoped. Composite Task 4 foreign keys remain the database backstop, and no generic API introduces GitHub-specific identifiers or literals.

The final transaction deliberately accepts an exact persisted retry before checking current absence revision or connection status. This is required for recovery after a successful commit whose response was lost; immutable history and exact source-bound event comparison prevent that exception from becoming a new mutation path. Fresh persistence always performs the current-scope and final-race checks.

`loadActivation` does not accept an execution time because the approved repository boundary does not include one. It returns the persisted window, while Task 8 must apply its captured Clock before provider reads. The final transaction remains the authoritative race-closing half-open revalidation.

The routing-decision schema does not persist a provider change-request external ID, so fresh event validation can bind repository identity, decision ID, change-request number through the decision, provider scope, actors, outcome, absence, revision, and occurrence time, but cannot independently derive `event.changeRequestId`. Task 8 must construct that field from its provider-qualified job/current-state contract. Exact retries still compare the complete event payload, including that ID.

No blocker remains.

## Fix round 1: make availability persistence replay safe

Implemented for commit `fix: make availability persistence replay safe` (the commit containing this section). This round addresses every independent review finding without editing historical migrations `0001` through `0006`.

### Finding-to-fix mapping

1. **Finalizer recovery independent of activation eligibility.** `ReviewerAbsenceActivation` now contains only the exact current revision and its unprocessed candidates. The workspace repository adds `listPendingFinalizers({ absenceId, absenceRevision })`, which reads pending recovery rows by immutable source scope without joining the current absence status/revision or active connection. Integration cases prove pending work remains available after revise, cancel, and provider-connection suspension; each case transitions the row to `permanent_failure`, removes it from the pending view, and retains it in history. A new revision activation returns no old-revision recovery field or candidates.
2. **Locked absence actor binding.** Fresh `persistReplacement` compares the locked `reviewer_absences.external_actor_id` byte-for-byte with `unavailableActorId` before decision or history mutation. A negative fixture deliberately makes the decision cohort refer to a different actor than the absence and proves history, event, and cohort all remain unchanged.
3. **Opaque provider actor IDs.** Generic DB parsing now rejects only empty/whitespace-only identifiers and otherwise preserves the exact provider-owned string. It does not add `@`, lowercase, regex-restrict, or trim persisted/comparison values. Tests cover case-distinct overlapping actors, a punctuation-bearing mixed-case identity, and a numeric GitLab identity without mutation or collision. Candidate pools and cohorts use the same exact, case-sensitive semantics.
4. **At-least-once candidate discovery.** Exact activation discovery supplies its absence ID/revision to `findReviewerReplacementCandidates`. A correlated `NOT EXISTS` excludes any decision already represented in replacement history for that source, regardless of outcome or finalizer state. Separate cases prove `no_replacement_available`, `skipped_closed`, and `permanent_failure` are not rediscovered on a second activation; exact persistence retry remains idempotent and history remains visible. Pending rows are returned only through the finalizer recovery boundary.
5. **Durable change-request identity.** Migration `0007_workspace_reviewer_availability.sql` adds nullable provider-neutral `routing_decisions.change_request_id`. Existing Phase decisions backfill it from their schema-v1 decision outbox payload; current-main decisions without a durable source remain null rather than deriving an identity from the numeric request number. The DB `DecisionInput` requires the value for new writes, retry upserts preserve it after terminal success, the worker routing composition passes the application contract's existing `changeRequestId`, candidate discovery excludes unknown historical identities, and final replacement persistence requires the locked decision value to equal `ReviewerReplacementEventV1.changeRequestId`. Fresh/schema, current-main, and current-Phase migration tests cover the column, intentional null, and exact outbox backfill respectively. Positive and mismatch replacement tests prove event binding and rollback.
6. **Release-suite and concurrency coverage.** Root `test:integration` now includes `packages/db/test/availability.integration.test.ts`. The concurrency regression starts a real transaction that updates and holds an absence revision, captures its PostgreSQL transaction ID, starts final persistence concurrently, and observes the final transaction waiting on that exact transaction-ID lock before release. After the revision commits, final persistence returns the stale no-op with no history. Removing the final `FOR UPDATE` would eliminate the observed wait and fail the test.

### TDD evidence

Tests were changed before production or migration code. The initial combined RED command covered availability, decisions, workspace isolation, schema, and upgrade histories. It exited 1 with 4 failed files, 1 passed file, 21 failed tests, and 18 passed tests. Failures were the absent `change_request_id` column, opaque IDs being rewritten/rejected, missing independent pending-finalizer API, processed decisions being rediscovered, and missing actor/event bindings. Workspace isolation remained green.

After the first implementation, the expanded availability behavior was correct, while two test-harness assumptions failed: equal-start rows were asserted in UUID order, and the lock probe filtered out transaction-ID locks because those locks have no database OID. The assertions were corrected without production changes: actor rows use literal unordered membership, and the concurrency barrier observes the captured blocking transaction ID directly. Availability then passed all 18 tests.

Final verification evidence:

- Required Task 6 plus schema, upgrade, and outbox suites: 6 files and 50 tests passed.
- Root `pnpm test:integration`, now including availability: 10 files and 73 tests passed.
- `pnpm --filter @triagepilot/db check`: passed.
- Rebuilt `@triagepilot/db`, then `pnpm --filter @triagepilot/worker check`: passed. The rebuild refreshed the ignored local package output so the worker checked against the new source contract.
- `pnpm check`: all workspace builds and checks passed.
- `git diff --check` and production boundary searches: passed.
- Historical migrations `0001` through `0006` are unchanged.
- Post-run inspection found zero `triagepilot_test_%` databases; the persistent `triagepilot` database was not migrated or mutated.

One attempted parallel verification paired `pnpm check` with the focused Vitest command. The check succeeded, but Vitest collected zero tests while package builds temporarily removed and recreated dependency `dist` entrypoints. That orchestration artifact was not counted as feature evidence; after the build completed, the focused suites and full integration script were rerun sequentially and passed with the counts above.

### API, migration, and residual concerns

The split between `loadActivation` and `listPendingFinalizers` is intentional: activation is allowed to become stale, while mapped finalizer work describes already-completed provider effects and must survive later administrative state changes. Exact source scope prevents old recovery from leaking into a revised activation.

The new decision column is nullable only for upgrade safety. A current-main historical decision has no provider external request ID in its row or event outbox, and the generic migration must not guess that identity from `pull_number`; such a row is therefore ineligible for a newly versioned replacement event. Current routing and current-Phase events persist/backfill the exact ID. A later operator recovery/reroute can create a fully identified current decision.

No blocker remains. No push, pull request, tag, publish, dependency change, commercial code, or persistent database operation was performed.
