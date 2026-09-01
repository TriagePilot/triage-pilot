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

Repository gates passed: `pnpm check`, `pnpm test` (554 passed, 101 expected integration skips), `pnpm build`, `docker build .`, `pnpm check:package-boundary`, `git diff --check`, and Gitleaks (110 commits, no leaks). The public-boundary diagnostic retained only its pre-existing findings in the internal Task 6 report; it reported no source boundary violation from this change.

### Crash and recovery semantics

Every non-terminal fresh candidate now has two provider reads. The second read occurs immediately before any mutation, persistence, or policy finalizer path, including `no_replacement_available`. A newly closed request, changed head, or arriving approval replaces the earlier plan and fails closed without stale mutation; an arriving satisfying approval maps to `skipped_policy_satisfied` plus policy reevaluation rather than policy failure.

The first fix round attempted to recover a replacement from current requested-reviewer state. Fix round 2 supersedes and removes that inference because even one eligible manual request is indistinguishable from a prior application write without durable provenance.

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

## Fix round 2: durable mutation intent

### RED and GREEN

The focused RED run failed 19 tests for the intended missing behavior: durable prepare/load ordering and serialization, fresh-process provenance, advisory requested reviewers, strict review parsing, throttling-aware classification, and permanent deterministic input errors. A subsequent terminal-state regression failed until a fresh retry loaded and serialized an existing intent even when its first provider read found the request closed. A blank-commit regression also failed before strict review validation was completed.

The final focused application/provider suites pass 80/80 tests. The affected application/provider/Task 5 core selection passes 132/132, and the Task 6 availability/outbox PostgreSQL contracts pass 38/38 with zero disposable test databases remaining. `pnpm check`, `pnpm test` (575 passed, 101 expected integration skips), `pnpm build`, `docker build .`, package-boundary diagnostics, `git diff --check`, and Gitleaks (111 commits, no leaks) pass. The standalone public-boundary diagnostic reports only the unchanged Task 6 artifact baseline and no Task 8 report finding.

### Intent lifecycle required for Task 9

`ReviewerMutationIntentKey` is provider-neutral and keys an intent by workspace, provider connection, absence, absence revision, and routing decision. `PrepareReviewerMutationIntentInput` also binds provider kind, repository identity, durable change-request identity, routed head, unavailable actor, and the exact selected replacement actor. `prepareMutationIntent` is an atomic create-or-load operation: an existing record is immutable and authoritative, never overwritten by a later selection. `loadMutationIntent` is called before mutable absence/load selection on a fresh enforce attempt.

For a new replacement, the application reads provider state, selects from immutable routing inputs, waits for `prepareMutationIntent` to complete, validates the returned source, then immediately re-inspects provider state before reconciliation. A failed prepare causes zero provider writes. If another attempt already prepared the key, the returned stored actor wins and is reconciled idempotently.

After prepare, DELETE, POST, and process death, a fresh job loads the same intent and does not read changed load or absence inputs. It re-inspects current request/head/reviews immediately before applying the stored actor and fails closed on closed, changed-head, approved-unavailable, or satisfied-policy state. Current `requestedActors` never establish provenance. A manual eligible request with no intent goes through ordinary selection and prepare; it is never attributed to earlier application work.

The intent ID is included in activation results, replacement persistence input, pending-finalizer records, and every recovery payload so Task 9 can serialize/resume the exact prerequisite. Storage must retain the immutable intent until terminal replacement history has been persisted. Activation processing does not delete it; any later deletion is retention cleanup and must not race an activation or finalizer retry. Task 9 must implement durable storage and worker composition before enabling dispatch.

### Advisory requests and strict provider reads

Replacement selection uses only the immutable routed cohort as `activeCohort`; provider requested reviewers remain advisory. A manually requested preferred actor therefore remains the preferred replacement, while GitHub reconciliation removes the unavailable reviewer, re-lists, and avoids a duplicate POST when that preferred actor is already requested.

GitHub replacement inspection now rejects a non-array reviews response and any review missing a valid user, actor login, user type, state, commit field, or submission field. Explicit nullable commit/submission values remain valid. Malformed approvals cannot be silently dropped or treated as safe human-policy state. The stricter parser is scoped to replacement inspection; the established generic policy-review reader retains its existing tolerant contract.

GitHub error classification keeps status/header/message interpretation inside the adapter. HTTP 429 is retryable. HTTP 403 is retryable for `Retry-After`, exhausted rate-limit headers, rate-limit messages, or secondary-limit messages; ordinary authorization/permission 403 remains permanent. HTTP 422 abuse, spam, secondary-limit, or retry hints are retryable, while deterministic validation remains permanent. Same-actor and team-actor replacement inputs use provider-owned permanent input errors. The application still consumes only `{ kind, message }`.

### Fix commit

This fix round is committed separately with subject:

```text
fix: persist reviewer mutation intent before writes
```

## Fix round 3: durable intent revalidation

### RED and GREEN

The focused RED run failed 12 tests: seven application cases for required finalizer linkage, intent loading before policy shortcuts, unconditional source/actor validation, changed replacement absence, current-head replacement approval, and non-mutating persistence behavior; five GitHub cases for commit provenance plus exact `User`/`Bot` typing and rejection of unsupported user types.

The focused application/provider suites now pass 92/92 tests. The affected core/application/provider suites pass 167/167. Task 6 availability/outbox PostgreSQL contracts pass 38/38 with zero disposable databases remaining. Repository gates pass: `pnpm check`, `pnpm test` (587 passed, 101 expected integration skips), `pnpm build`, `docker build .`, package-boundary checks, `git diff --check`, and both Git history and working-directory Gitleaks scans. The standalone public-boundary diagnostic continues to report only the unchanged Task 6 artifact baseline and no Task 8 report finding.

### Intent validation and final eligibility

Every enforce candidate loads an existing intent before policy-state or provider-state shortcuts. A loaded record is immediately validated against the complete immutable source identity and eligible actor pool. An invalid ID/source/actor becomes a linked `permanent_failure` without any provider inspection or mutation; no later provider-state transition can expose an unvalidated intent.

Before any reviewer mutation, the application re-inspects the current request and then queries active absences for only the exact intended actor at the captured activation instant. It does not recompute load or select a different actor. If that actor became absent, the application persists a linked terminal `permanent_failure` with zero provider effects. If that actor has an active human approval on the current head, a satisfied approval count retains `skipped_policy_satisfied`; otherwise the application persists a linked terminal failure and never requests an already-approved actor. Persistence failure on either zero-effect terminal path surfaces as an ordinary job retry and cannot produce a provider-effect recovery payload.

The same final eligibility check applies to an intent loaded after process death and to a newly prepared intent. `prepareMutationIntent` still completes before DELETE/POST, and the extracted prepare-and-validate helper makes both planning paths use the same authoritative validation.

### Required provenance linkage for Task 9

`mutationIntentId` is now an explicit required `string | null` on replacement persistence, pending-finalizer records, activation results, and recovery payloads. Existing intent IDs are retained through policy success/failure, closed/head/provider terminal outcomes, finalizer replay, and every recovery phase. Reviewer-mutation outcomes carry the non-null prepared intent ID; outcomes without an intent explicitly carry null.

Task 9 must implement the durable intent port and store this required field. Intent retention remains unchanged: keep the immutable record through terminal replacement-history persistence and finalizer recovery, then allow only later retention cleanup. Task 9 must not infer provenance from requested reviewers or dispatch activation before intent storage is composed.

### Strict GitHub review identity

Replacement inspection now maps only the exact GitHub type `User` to a human and exact `Bot` to a bot, and carries the review commit identity into provider-neutral application metadata. `Mannequin`, case-changed values, unknown values, and future values are permanent malformed protocol state. They cannot be counted as human approvals. The established generic review-reading path remains unchanged.

### Fix commit

This fix round is committed separately with subject:

```text
fix: revalidate durable reviewer intent
```

## Fix round 4: required mutation provenance and current-author revalidation

### RED

The focused application RED ran 40 tests and failed the three intended regressions. A `replaced` pending-finalizer row with null actor/intent provenance replayed successfully, a loaded durable intent could request the current change-request author, and an author change after intent prepare/process death led to reviewer mutation plus provider-effect recovery instead of a linked zero-effect terminal failure.

The standalone application type-contract RED failed three assertions. `ReviewerReplacementFinalizerRecord`, `PersistReviewerReplacementInput`, and `ReviewerReplacementFinalizerRecovery` each still admitted the malformed `replaced` plus null-provenance shape.

### GREEN

The focused replacement application/GitHub adapter suites pass 95/95 tests. All application, provider, and core suites pass 170/170. The application package check includes the negative type-contract suite and passes. Task 6 availability/outbox PostgreSQL contracts pass 38/38 against UUID-named disposable databases, with zero disposable databases remaining. The default full suite passes 590 tests with 101 expected integration skips.

Repository gates pass: `pnpm check`, `pnpm build` through that check, `docker build .`, `pnpm check:package-boundary`, `git diff --check`, and both Git-history and working-directory Gitleaks scans. The standalone public-boundary diagnostic still reports only its two documented pre-existing Task 6 report findings; it reports no new source finding.

### Discriminated provenance contracts

`ReviewerMutationIntentId` is now a branded string produced by `parseReviewerMutationIntentId`, which rejects blank runtime IDs. `ReviewerReplacementProvenance<Outcome>` is the shared outcome discriminant:

- `replaced` requires a non-null replacement actor and branded mutation-intent ID;
- `simulated_replacement` requires a non-null replacement actor and an explicit null mutation-intent ID;
- every non-mutating outcome requires an explicit null replacement actor and carries either a validated existing intent link or explicit null.

Pending-finalizer records admit only the three mapped finalizer outcomes. Persistence also discriminates its replacement actor, mutation intent, cohort-replacement flag, and event outcome/actor. Recovery now carries its outcome and replacement actor directly: `replaced` recovery is always provider-effecting and fully linked; provider-effecting `permanent_failure` also requires a branded intent ID in both recovery and persistence; policy-only recoveries are explicitly provider-write-free. Phase fields are discriminated so persist recovery requires its exact persistence input while replayed run/complete recovery may omit it only after a durable replacement row exists.

Runtime assertions validate the same provenance invariants at pending-finalizer load, persistence construction, and recovery construction/parsing boundaries. Invalid pending data fails before the policy finalizer runs. The valid replay regression retains the linked actor/intent and continues to perform no provider inspection, DELETE, or POST.

### Current-author revalidation

The final durable-intent eligibility check now compares the intended replacement with `authorActor` from the latest provider inspection before any reviewer mutation. This runs for both loaded and newly prepared intents, in addition to current absence and current-head approval validation.

An existing intent targeting the current author persists a linked `permanent_failure` with zero provider effects. The process-death regression prepares an intent, terminates before reviewer mutation, changes the observed author, and retries twice: the first terminal-persistence attempt fails as an ordinary job retry without a provider-effect recovery; the next attempt loads the same intent ID and persists the same linked terminal failure. Neither retry invokes reviewer reconciliation.

### Fix commit

This fix round is committed separately with subject:

```text
fix: require reviewer mutation provenance
```
