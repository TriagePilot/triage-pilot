# Task 9 Report: Dispatch Availability Jobs and Recover Finalizers

## Status

Task 9 and fix round 1 are complete. Claimed reviewer-absence jobs validate scope before composing database repositories, credentials, or provider adapters. Activation uses the Task 8 use case, resumes durable provider-mutation intent, preserves finalizer provenance, and continues across all candidates in the same claimed activation.

Migration `0008_reviewer_mutation_intents.sql` remains the highest migration. Migrations `0001` through `0007` were not changed. Task 14 must update its release evidence to expect `0008`; it must not create or start another migration for this handoff.

## RED and GREEN

The review findings were implemented test-first. Narrow RED slices proved the missing behavior before implementation:

- recovery A incorrectly ended the whole claimed activation instead of continuing to B;
- orphaned prepared intent could disappear behind revise, cancel, or connection suspension;
- retention could delete a decision required by intent or finalizer recovery;
- invalid outcome/state pairs reached persistence adapters;
- `complete_replacement` rejected an already-committed exact completion;
- persist-phase exhaustion and last-attempt stale leases could lose durable failure visibility;
- intent rows were mutable by direct SQL and direct inserts could mix repository sources;
- recovery bounds inherited an unrelated larger job maximum;
- permanent finalizer failures were treated as retryable;
- report handoff incorrectly described a later migration.

Final GREEN evidence:

- application, processor, runner, and runtime units: 124/124;
- real PostgreSQL crash/continuation matrix: 15/15;
- self-hosted worker composition: 10/10;
- availability database slice: 34/34;
- full supported PostgreSQL integration gate: 101/101;
- root suite: 622 passed, 134 expected database-dependent skips;
- build and type checks, package boundary, Compose rendering, Docker build, diff check, and both Git-history and working-tree secret scans passed.

The standalone public-boundary diagnostic continues to report only the two inherited Task 6 report findings present at the base revision. Its unit gate passes and this change adds no finding.

## Storage and source integrity

`reviewer_mutation_intents` is provider-neutral durable storage. The atomic create-or-load key is `(workspace_id, provider_connection_id, absence_id, absence_revision, decision_id)`. The immutable row stores provider, repository record and external identity, change-request identity, expected head revision, unavailable actor, and selected replacement actor.

`prepareMutationIntent` locks and validates the current source, uses `INSERT ... ON CONFLICT DO NOTHING`, reloads the authoritative row, and compares every immutable field. An exact concurrent retry receives the same intent; a differing proposal fails closed. A database trigger rejects direct updates.

Composite constraints bind the intent to the same provider connection, repository record, external repository identity, and decision repository. An insert trigger validates the current absence revision. A foreign key cannot include revision because revision is intentionally mutable after preparation; the insert-only trigger validates creation without preventing later revise/cancel recovery. Direct mixed-source and wrong-revision inserts are rejected.

`reviewer_replacements.mutation_intent_id` retains provenance through replacement persistence and finalizer recovery. Runtime boundaries parse nonblank branded intent IDs, and stale-job recovery accepts only UUID-shaped database identities.

## Intent lifecycle and crash table

| Interruption | Durable state | Exact recovery |
| --- | --- | --- |
| Before prepare | no intent/effect | ordinary selection may run |
| After prepare | immutable actor intent | resume the same actor; never select another |
| After DELETE | intent plus possible partial provider state | inspect state; never repeat completed DELETE |
| After POST | intent plus applied provider state | perform no provider write; persist linked history |
| After history commit | linked `finalizer_pending` row | run only its mapped finalizer |
| After completion commit | exact completed row | `complete_replacement` replay succeeds idempotently |
| Activation changed after prepare/DELETE/POST | unfinalized intent | write linked `permanent_failure` audit/event with no provider, policy, finalizer, or cohort write |

The real database matrix covers prepare, DELETE, and POST interruption followed by each of revise, cancel, and provider-connection suspension. It also covers current-state resumption, final persistence, and finalizer interruption. Provider write counts prove completed effects are not replayed.

Unfinalized intents are discovered independently of current absence revision/status and active connection. When the original activation is still current, it resumes normally. When it is no longer valid, recovery-specific persistence validates the immutable intent/source, creates one idempotent permanent-failure history/event, and leaves the reviewer cohort untouched.

## Continuation and recovery phases

After a recovery phase returns success, the runner invokes activation processing again under the same claim. Completed A is excluded by history, then B is processed. Real tests cover A recovery followed by fresh B and by B pending finalizer; A provider effects remain at one DELETE and one POST.

Recovery remains separate from policy-check recovery and is discriminated as:

- `persist_replacement`: exact persistence payload and durable intent; provider effects are never repeated;
- `run_finalizer`: exact pending replacement, outcome, actor, intent, and mapped finalizer;
- `complete_replacement`: exact pending or already-completed replacement; only state completion is allowed.

Persistence validators require `permanent_failure` outcome to use permanent-failure state and nonblank error, mapped finalizer outcomes to begin pending with no error, and outcomes without finalizers to begin completed. Database insert enforcement and runtime record validation reject invalid combinations before writes. A mapped replacement may later be completed or permanently failed by its finalizer lifecycle.

Permanent and retryable finalizer classifications remain intact through application, processor, and runner. Permanent errors stop immediately and persist visible terminal state.

## Retention, exhaustion, and stale leases

Ninety-day decision retention uses per-row `NOT EXISTS` protection for mutation intents, replacement history, and queued/running activation jobs. Protected rows do not abort deletion of unrelated expired decisions. The decision foreign key is restrictive, so retention cannot cascade-delete intent provenance. Terminal cleanup remains future work; safety currently favors retention.

The first recovery grants exactly three additional claims by setting `max_attempts = current attempt + 3`. Later recovery phases retain that fixed maximum. Tests cover an attempt-1/default-max-5 activation receiving only attempts 2, 3, and 4.

Persist-phase stale rejection, explicit exhaustion, and stale last-attempt recovery all create linked permanent-failure audit history without cohort/provider/finalizer mutation. Revised, cancelled, suspended, and window-expired cases are covered, including exact replay.

Stale last-attempt finalizer recovery locks the job transactionally, validates kind/workspace/provider connection/replacement/absence revision/decision/outcome/actor/intent, updates the exact pending replacement to permanent failure, then fails the job in the same transaction. Malformed recovery fails the job without mutating an unrelated replacement. Every ordinary worker transition still requires the exact claimed lease; stale workers cannot overwrite newer state.

## Test and operational hygiene

All database tests used a disposable PostgreSQL container on a random host port with no persistent volume. No credential value was emitted. The container was removed after verification.

Representative commands:

```text
TEST_DATABASE_URL=<disposable> pnpm test:integration
TEST_DATABASE_URL=<disposable> pnpm exec vitest run apps/worker/test/availability-runtime.integration.test.ts apps/worker/test/self-hosted-composition.test.ts
pnpm test
pnpm check
pnpm check:package-boundary
pnpm check:public-boundary
docker compose config
docker build -q .
gitleaks git --no-banner --redact .
gitleaks dir --no-banner --redact .
git diff --check
```

## Commit

Single local commit subject: `fix: make availability recovery lossless`.

No push, pull request, tag, publication, dependency change, credential output, or persistent database operation was performed.

## Concerns

- Intent and protected terminal-history cleanup is intentionally deferred. Any later cleanup must prove no activation, recovery job, or finalizer can still reference the rows.
- The standalone public-boundary command still exits nonzero for the two inherited Task 6 report findings; the boundary unit gate passes and Task 9 adds none.
- Task 14 only updates release evidence for highest migration `0008`; it does not create or begin another migration.
