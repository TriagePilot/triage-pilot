# Final Review Fix Report

Date: 2026-09-03

Reviewed base: `7deb717b3524d00e7a49b91b46d1d4f529e0471c`

Implementation commit: `fc6dff0` (`fix: fence reviewer policy finalizers`)

## Status

DONE. The Critical inactive-provider reviewer-policy-finalizer defect and both Minor test-hardening findings from `final-review.md` are fixed. No pull request, push, tag, publication, release, or live GitHub mutation was performed.

## Critical fix

The reviewer-policy finalizer no longer opts out of active provider-connection scoping. Provider-facing finalizer work now runs through the same claimed reviewer-mutation authority path as reviewer-request reconciliation:

1. validate the exact claimed job lease;
2. lock and validate the exact reviewer absence/revision;
3. lock and require the exact provider connection to remain `active`;
4. issue GitHub requests through a requester that rechecks the live authority before every request and forwards the authority abort signal.

This preserves the required lock order and prevents any new GitHub read or check-run write from starting after suspension or status-first revocation commits. Authority timeout/loss also prevents subsequent provider requests. A missing or revoked connection maps to permanent recovery; suspension remains retryable so reactivation can resume the durable pending finalizer. The local-only `complete_replacement` finalizer deliberately remains outside provider I/O authorization and can still complete after either suspension or revocation.

Durable intent and history semantics remain visible and replay-safe:

- revoked provider-facing finalizers make zero provider calls and recover permanently;
- terminal exhaustion updates the existing replacement history row to `permanent_failure` instead of creating false history or pretending finalization succeeded;
- suspended provider-facing finalizers make zero provider calls, remain pending/retryable, and complete after reactivation;
- local-only replacement completion succeeds without provider access;
- concurrent suspend/revoke operations serialize behind an active finalizer authority lease;
- once authority ends, later policy reads or writes cannot start.

No schema or migration changed.

## TDD evidence

RED, against the previous implementation:

```text
TEST_DATABASE_URL=<disposable PostgreSQL 16 URL> pnpm vitest run \
  apps/worker/test/availability-runtime.integration.test.ts \
  -t 'pending policy finalizer|local-only replacement finalization' \
  --reporter=dot --maxWorkers=1 --minWorkers=1

Expected failure: 2 failed, 2 passed, 24 skipped.
Both revoked and suspended pending policy finalizers reached the fake GitHub
check-runs route; revoked recovery also remained retryable.
```

GREEN, after the authority-fence implementation and expanded race coverage:

```text
TEST_DATABASE_URL=<fresh disposable PostgreSQL 16 URL> pnpm vitest run \
  apps/worker/test/availability-runtime.integration.test.ts \
  apps/worker/test/runtime-services.integration.test.ts \
  packages/db/test/availability.integration.test.ts \
  packages/db/test/jobs.integration.test.ts \
  packages/db/test/deliveries.integration.test.ts \
  --reporter=dot --silent --maxWorkers=1 --minWorkers=1

PASS: 5 files, 132 tests.
```

The runtime integration matrix includes revoked and suspended pending-policy replay, revoked failure finalization, both provider-first interleavings, local-only completion for both inactive statuses, and timeout followed by revocation. Assertions cover zero unauthorized provider calls/writes and no false history or unintended finalization.

Focused non-database coverage:

```text
pnpm vitest run \
  apps/worker/test/availability-processor.test.ts \
  apps/worker/test/runtime-services.test.ts \
  apps/worker/test/runner.test.ts \
  packages/application/test/reviewer-availability.test.ts \
  packages/provider-github/test/adapter.test.ts \
  packages/ui/test/operations-dashboard.test.tsx \
  packages/core/test/availability.test.ts --reporter=dot

PASS: 7 files, 214 tests.
```

Full non-database suite:

```text
pnpm test --reporter=dot --silent
PASS: 61 files, 713 tests; 15 database-conditioned files and 204 tests skipped.
```

Static/build and boundary checks:

```text
pnpm check
PASS: workspace builds, TypeScript checks, application negative contracts,
and the web Vite build.

pnpm check:package-boundary
PASS.

pnpm check:public-boundary
PASS.

git diff --check 7deb717b3524d00e7a49b91b46d1d4f529e0471c..HEAD
PASS.
```

## Minor findings

- The operations dashboard now has explicit zero and null quota fixtures proving that it does not render misleading quota text.
- The core public-boundary test explicitly asserts that `selectTieredReviewers` is absent from `@triagepilot/core`.

Both are test-only changes; no public API changed.

## Scope and residual concerns

The fix is limited to worker runtime authorization and its regression tests plus the two requested Minor test assertions. Existing provider calls already in flight retain the documented external-operation ambiguity, but the live authority abort signal prevents any later call from starting and persistence remains fenced. The intentionally side-effecting live-organization test was not run. No new merge blocker is known; the candidate is ready for the requested single scoped rereview.
