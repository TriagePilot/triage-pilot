# Task 7 Report: Exclude Absent Reviewers From Routing

## Status and commit

Task 7 is implemented and verified in the isolated Phase 0 worktree. The Task 7 commit is `feat: exclude absent reviewers from routing`; its hash is reported in the handoff because a commit cannot embed its own final hash.

No push, pull request, tag, publication, dependency change, persistent database mutation, historical migration edit, GitHub type in a generic package, or private-host implementation was performed.

## Carried Task 6 ruling

The carried corrupt-singleton regression was written first in `packages/db/test/outbox.integration.test.ts`. A source-bound routing event was changed to a self-consistent but noncanonical event ID, then retried through the canonical callback. RED failed as required because the retry resolved and staged a second event instead of rejecting.

`persistDecisionWithEvent` now selects source-bound routing events only by durable workspace and decision source, retains the complete validated singleton event, and compares the callback event against its full immutable payload before staging. Zero rows still use the locked decision `created_at`; multiple rows and malformed source/payload identity still fail closed. A mismatch rejects the transaction and leaves the single existing event unchanged.

Focused carried-ruling GREEN covered the corrupt singleton, ambiguous source rows, fresh delayed retry time, and migrated terminal retry time: 2 files, 4 tests passed. The complete root integration run also kept those paths green.

## Task 7 RED and GREEN

Application and worker tests were added before availability production wiring. The feature-specific RED command ran the application routing, worker runtime unit, and worker runtime integration files. It failed with the intended three failures: zero Clock/availability calls in application routing and missing runtime availability ports in both worker suites.

After the minimal implementation, the same feature-specific selection passed 3 files and 3 tests. The broader application/worker routing command passed 5 files and 70 tests, covering application routing, worker processor/runner, runtime unit behavior, and real-PostgreSQL runtime composition.

## Captured-time and query-count semantics

For a routable change request, the application captures one availability evaluation instant from the injected `Clock`. It normalizes and deduplicates the union of preferred and eligible ownership actors, makes exactly one workspace/provider-connection-scoped availability query at that instant, and applies the returned windows to both tiers with `availableActorsAt`.

Reviewer load is requested only for the available eligible actors. Selection receives only the available preferred and eligible tiers. Immutable decision details retain the original unfiltered ownership result plus:

```text
availability.evaluatedAt
availability.excludedReviewers
```

Author exclusion, active-approval exclusion, draft handling, live configuration resolution, preferred-first fallback supplementation, requested quota/shortfall, enforce/shadow behavior, and atomic decision-event persistence remain on their existing paths.

## Runtime wiring

`RoutingApplicationPorts` now exposes the provider-neutral availability port using `WorkspaceId`, `ProviderConnectionId`, `ExternalActorId`, `Date`, and `ReviewerAbsenceWindow`; no provider-specific request type enters the application package.

The worker binds `createWorkspaceReviewerAvailability` to the routing job workspace and delegates `findActive` to Task 6 `findActiveAbsences` with the job's provider connection, actors, and captured instant. A scope mismatch fails before repository access. The real-DB runtime integration test schedules an absence and proves that the worker port returns the workspace/provider-connection-scoped window without provider access.

## Verification

- Carried-ruling focused GREEN: 2 files, 4 tests passed.
- Application routing plus worker processor/runner/runtime unit/integration: 5 files, 70 tests passed.
- Root disposable-PostgreSQL integration: 10 files, 85 tests passed.
- Root `pnpm check`: all builds and workspace TypeScript checks passed, including application, DB, and worker.
- `pnpm check:package-boundary`: passed.
- `git diff --check`: passed.
- Historical migrations are unchanged.
- Post-run PostgreSQL inspection found zero `triagepilot_test_%` databases.

`pnpm check:public-boundary` still reports two prohibited product-scope terms in the pre-existing, unchanged internal Task 6 report. The Task 7 application/DB/worker source passes the package-boundary check and introduces neither concept. This is a baseline internal-report scanning concern, not a Task 7 source boundary failure.

## Files

- `packages/application/src/routing.ts` and `packages/application/test/routing.test.ts`
- `apps/worker/src/runtime-services.ts`
- `apps/worker/test/runtime-services.test.ts` and `apps/worker/test/runtime-services.integration.test.ts`
- `apps/worker/test/processor.test.ts` and `apps/worker/test/runner.test.ts` for the required application-port fixture
- `packages/db/src/decisions.ts` and `packages/db/test/outbox.integration.test.ts` for the carried ruling

## Concerns

No Task 7 blocker remains. The only observed concern is the pre-existing public-boundary script finding internal Task 6 report vocabulary described above.

## Fix round 1: enforce routing order and runtime scope guards

The two Important review gaps were closed with tests only; the assertions passed against the existing production implementation, so no production change was required.

The application regression `filters both routing tiers at one captured instant before loading available actors` now compares `availability.findActive` and `reviewerLoad` through Vitest `invocationCallOrder`. It retains the assertions for exactly one Clock call, exactly one availability call, normalized union arguments, the captured instant, filtered load actors, and immutable availability details.

Worker runtime coverage adds two independent regressions:

- `rejects a wrong-workspace availability lookup before repository or provider access`
- `rejects a wrong-provider-connection availability lookup before repository or provider access`

Each uses a non-empty actor list, a `selectFrom` spy for repository database access, and a provider-request spy. Each expects the literal `availability lookup scope does not match routing job` error and zero calls to both spies. Removing either corresponding guard makes its test leave the guarded path and fail, while the existing real-PostgreSQL matching-scope success test remains green.

Focused new-assertion command:

```text
pnpm vitest run packages/application/test/routing.test.ts apps/worker/test/runtime-services.test.ts -t 'filters both routing tiers|wrong-workspace availability|wrong-provider-connection availability'
```

Result: 2 files passed; 3 tests passed and 40 unrelated tests skipped.

Full named routing/runtime command used the disposable PostgreSQL harness:

```text
TEST_DATABASE_URL=<local disposable-test server> pnpm vitest run packages/application/test/routing.test.ts apps/worker/test/runtime-services.test.ts apps/worker/test/runtime-services.integration.test.ts
```

Result: 3 files and 47 tests passed, including all 4 real-DB runtime integration tests. Application and worker TypeScript checks passed, `git diff --check` passed, and post-run inspection found zero `triagepilot_test_%` databases. Root integration was not rerun because neither production nor integration-test code changed in this test-only round.
