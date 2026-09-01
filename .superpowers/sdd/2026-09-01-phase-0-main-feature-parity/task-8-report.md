# Task 8 Report: Replacement Orchestration and Provider Actions

## Status

Implemented the provider-neutral reviewer-absence activation use case and GitHub current-state/reviewer-request mappings. The application flow replays durable pending finalizers before fresh work, separates read, plan, apply, and finalize phases, and stops with an explicit recovery payload whenever reviewer effects completed but final persistence or finalization remains outstanding. Worker dispatch is intentionally left to Task 9.

No migration, dependency, worker-dispatch, repository-configuration, private-host, or unrelated behavior changed. Shadow activation performs provider reads for equivalent planning but never invokes reviewer mutation or policy-finalizer writes.

## RED

Tests were added before the initial production implementation:

```text
pnpm vitest run packages/application/test/reviewer-availability.test.ts packages/provider-github/test/adapter.test.ts
```

Result: exit 1. The application suite failed to load because `packages/application/src/reviewer-availability.ts` did not exist. Seven new GitHub adapter tests failed because current replacement inspection and reconciliation were not implemented; the 17 pre-existing adapter tests passed.

A later semantic correction was also test-first. The terminal-policy regression failed because `permanent_failure` was persisted as `completed` with no error. The implementation now writes state `permanent_failure` with the exact terminal reason as `lastError`.

The exact replacement-event assertion was mutation-checked by changing its deterministic suffix from `v1` to `v2`; the focused test failed on the event ID and passed again after restoration.

## GREEN

Initial focused GREEN passed 2 files and 40 tests. After the phase extraction, exact-event assertion, and terminal-state correction, the complete application/provider selection passed:

```text
pnpm vitest run packages/application/test packages/provider-github/test
```

Result: exit 0; 10 files and 84 tests passed.

The Task 5 core policy contract passed 9/9. The Task 6 PostgreSQL availability and outbox contract suites passed 38/38 against UUID-named disposable databases, including locked final-race rejection, replacement/event atomicity, finalizer durability, and event-source validation. Zero disposable databases remained afterward.

`pnpm check`, `pnpm check:package-boundary`, and `git diff --check` passed.

## Phase model

- Read: capture one activation instant, load revision-specific pending finalizers, load the exact current activation, inspect current provider request/reviews, and read absence/load inputs only from the immutable persisted original pool.
- Plan: use Task 5 `selectReplacement`, current active human approvals, requested approval count, active cohort, author, concurrent absences, preferred tier, and fallback tier. Closed, changed-head, approved-unavailable, satisfied-policy, and terminal-policy paths produce explicit non-mutating outcomes.
- Apply: in enforce mode only, re-inspect provider state immediately before mutation, recalculate the plan from current reviews, then reconcile one unavailable/replacement pair. Shadow skips every provider write.
- Finalize: capture completion time, persist history/cohort/event through Task 6 locked persistence, run the outcome-mapped policy finalizer, then transition `finalizer_pending` to `completed`.

## Retry and finalizer semantics

GitHub reconciliation reads the requested-user set on every attempt. It removes the unavailable actor first only when present, then requests the replacement only when absent. A retry after removal therefore performs only the missing request; an already reconciled request is a no-op.

Fresh outcomes requiring a policy action are persisted as `finalizer_pending`. `replaced` and `skipped_policy_satisfied` map to `reevaluate_policy`; `no_replacement_available` maps to `fail_policy` without reducing the requested approval count. Durable pending rows replay only that mapped finalizer before fresh activation work.

If reviewer effects completed but locked persistence rejected or threw, the use case returns a complete `reviewer_replacement_finalizer` recovery with phase `persist_replacement`, the exact immutable persistence/event input, the mapped finalizer, and `providerEffectsApplied: true`. Later failures distinguish `run_finalizer` from `complete_replacement`, so Task 9 can resume without repeating reviewer effects.

## Provider mapping

The GitHub adapter owns GitHub login normalization: trim, remove one leading `@`, lowercase, and restore one leading `@` at its public result boundary. Mutation payloads contain lowercase GitHub user logins without `@`; team actors are rejected for replacement mutations because repository configuration supports individual users only.

Current inspection maps pull-request state/head/author, paginated requested users, and reviews into normalized actor IDs plus provider-neutral review metadata. Malformed required pull-request fields fail closed. Inspection, removal, and request errors propagate unchanged.

The generic application package imports no GitHub types, parses no GitHub URL, and never removes or adds handle prefixes. `ExternalActorId` remains opaque there.

## Tests

Application coverage includes stale/cancelled and inactive activation, closed request, current-head re-read, unavailable approval, approvals arriving before writes, terminal policy state, immutable pool, preferred-first and fallback selection, exact event/time staging, no replacement, partial mutation retry, shadow zero writes, locked race recovery, thrown persistence recovery, and durable finalizer-only replay.

GitHub coverage includes current inspection, exact normalization, idempotent no-op, removal-before-request ordering, retry after removal, and inspection/removal/request error propagation. Existing routing comments, reviewer requests, approvals, checks, labels, configuration, credentials, normalization, and webhook tests remain green.

## Commit

This report is included in the single requested commit with subject:

```text
feat: reconcile unavailable review requests
```

The final commit SHA is returned in the task handoff.

## Concerns

Task 9 must validate and serialize the complete recovery contract, compose Task 6 candidate/record shapes into the public application types, and treat a persist-phase locked stale rejection as terminal recovery without invoking reviewer reconciliation again. No Task 8 blocker remains.

## Fix round 1: crash-safe reconciliation

### RED

The review findings were reproduced test-first. The focused application/provider command initially failed 16 tests covering the missing second provider read for non-mutation outcomes, approval arrival before policy failure, fresh-job recovery after provider success, ambiguous recovery, permanent-error continuation, mutation-sensitive adapter re-listing, malformed payload handling, unsupported requested-reviewer pagination, and provider error classification. A final focused regression also failed because a malformed provider protocol response was initially classified as retryable.

### GREEN

After the fix, the focused replacement suites pass 59/59 tests. The full application/provider and Task 5 core selection passes 111/111. Task 6 availability/outbox PostgreSQL contracts pass 38/38, including locked final-race and event-atomicity cases, with zero disposable test databases remaining.

Repository gates passed: `pnpm check`, `pnpm test` (554 passed, 101 expected integration skips), `pnpm build`, `docker build .`, `pnpm check:package-boundary`, `git diff --check`, and Gitleaks (110 commits, no leaks). `pnpm check:public-boundary` retains the pre-existing diagnostic against the internal Task 6 report's words `commercial` and `saas`; it reports no new source boundary violation from this change.

### Crash and recovery semantics

Every non-terminal fresh candidate now has two provider reads. The second read occurs immediately before any mutation, persistence, or policy finalizer path, including `no_replacement_available`. A newly closed request, changed head, or arriving approval replaces the earlier plan and fails closed without stale mutation; an arriving satisfying approval maps to `skipped_policy_satisfied` plus policy reevaluation rather than policy failure.

After DELETE and POST succeed but the process dies before persistence, a fresh job does not rely on the lost in-memory recovery payload. It inspects `requestedActors` and recognizes exactly one requested actor that belongs to the immutable original eligible pool but not the immutable original cohort, unavailable actor, current author, or approved set. It persists/finalizes that actor as the recovered replacement without re-reading mutable absence/load inputs or repeating provider effects. An original-cohort/manual request is never inferred as a replacement. If more than one actor could be the applied replacement, the job records `permanent_failure`; preferred membership is not used to guess because the historical absence/load inputs that determined whether preferred or fallback was selected are unavailable after process death. A single pre-existing eligible actor outside the original cohort remains intrinsically indistinguishable from the successfully POSTed actor; the contract deliberately requires immutable cohort snapshots and fails closed when provider state exposes multiple candidates.

Provider effects followed by failed or stale final persistence still produce the Task 9 recovery contract. A permanent mutation error is treated conservatively as possibly partially applied; if terminal persistence also fails, recovery has phase `persist_replacement`, the exact permanent-failure persistence/event input, `providerEffectsApplied: true`, and a null policy finalizer. Task 9 must resume that persistence input and must not repeat provider mutation.

### Permanent provider errors

The application owns only a provider-neutral `{ kind: "permanent" | "retryable", message }` classification boundary. Permanent inspection or mutation failures are persisted per candidate as `permanent_failure` with the useful provider message in reason, `lastError`, history, and event, after which later candidates continue. Retryable failures surface to the job runner and do not write terminal history.

The GitHub adapter owns status and protocol mapping: HTTP 400, 401, 403, 404, 410, and 422 are permanent; malformed required replacement-inspection/requested-reviewer payloads are permanent protocol failures; other statuses and unknown/network errors are retryable.

### Adapter freshness

GitHub mutation now lists requested users, removes the unavailable reviewer only when present, then lists requested users again immediately before deciding whether to POST the replacement. This repairs a concurrently removed replacement and avoids an unnecessary POST for a concurrently added replacement while preserving DELETE-before-POST and partial-retry idempotency. The requested-reviewers endpoint is read once per inspection without unsupported `page`/`per_page` looping; malformed payloads and malformed user records fail closed, and an exact 100-user response remains a single request.

### Fix commit

This fix round is committed separately with subject:

```text
fix: make reviewer replacement crash safe
```
