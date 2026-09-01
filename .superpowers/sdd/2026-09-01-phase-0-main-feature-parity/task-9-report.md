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

## Fix round 2: atomic activation exhaustion

### RED/GREEN mapping

The runner RED slice demonstrated both final-bound continuation failures: after A recovery, a retryable B throw retained A as the in-memory recovery, and terminal handling audited separately from the job lease transition. A second RED case covered B returning a recovery on the last bounded claim. Both now route through one workspace-job repository operation; the focused runner/application/processor suite is 96/96 and the real runtime/composition matrix is 25/25.

The PostgreSQL RED slice exercised an original `activate_reviewer_absence` payload with no serialized recovery. An obsolete lease produced neither history nor job mutation. The exact lease now discovers the durable intent, inserts the linked permanent-failure audit/event, and fails the job in one commit. Availability/jobs/schema integration is 47/47.

### Transaction and state flow

```text
runner terminal activation
  -> exhaustReviewerAbsenceActivation(exact lease, error, now)
    -> BEGIN
    -> lock exact running job by workspace/provider/connection/owner/attempt
    -> validate durable activation scope and any serialized recovery source
    -> lock/read every intent and same-source history for absence+revision
    -> require history.mutation_intent_id = intent.id when history exists
    -> audit every unresolved intent; fail every scoped pending finalizer
    -> transition the same locked job to failed
    -> COMMIT
```

A stale lease returns `stale_lease` before any audit or replacement write. Stale maintenance enumerates candidates, then runs this transaction independently for each job, so one invalid source cannot roll back a valid job in the same maintenance batch. Ordinary non-availability stale jobs retain their previous failure behavior.

After A recovery succeeds, the runner clears A before resuming activation. A B throw on the last bounded claim therefore exhausts the durable activation scope, not A's old serialized object. A returned B recovery uses the same terminal transaction. The recovery ceiling remains the original bounded ceiling.

### Scope and lock hardening

Finalizer and replacement recovery records now carry and validate workspace, provider, provider connection, absence ID/revision, decision, unavailable actor, outcome, replacement actor, replacement ID, and mutation-intent ID. Runtime parsing additionally binds the claimed provider and job scope. Database exhaustion binds serialized replacement recovery to the exact durable row before any finalizer-state mutation; persistence-phase recovery binds the exact intent.

`prepareMutationIntent` and terminal persistence share the absence-first lock order. Preparation locks absence and decision, rechecks same-source terminal history under the lock, and returns only an exact already-linked intent; otherwise terminal history prevents a new intent. The insert trigger locks the absence row with `FOR UPDATE`, serializing insert-first and revise-first orderings. Recovery audit persistence also locks absence before checking history, making concurrent exact audit calls idempotent while differing payloads fail closed.

Unfinalized discovery no longer treats arbitrary same-source history as resolution: only history linked to the exact intent is resolved; incompatible history raises a visible integrity error. Atomic exhaustion prevalidates all history links before writing any audit.

### Database state enforcement

Migration `0008` remains the highest migration. Its revision validator now locks the absence row. Replacement checks use explicit `IS NULL`/`IS NOT NULL` predicates, exclude `permanent_failure` from completed state, and require a nonblank error for permanent state. INSERT and UPDATE triggers enforce the discriminated state/outcome rules while allowing repository-controlled pending-to-completed/permanent transitions. No `0009` is introduced; Task 14 still updates evidence only through `0008`.

### Verification and concerns

Fresh evidence for this round includes 96/96 focused worker/application tests, 47/47 availability/jobs/schema PostgreSQL tests, 25/25 runtime crash/continuation and composition tests, a clean full build/type check, and `git diff --check`. The full PostgreSQL root run initially exposed four mapping/regression failures; those were corrected by preserving full scope in runtime record adapters, clearing persistence from finalizer-only recovery phases, and retaining the original malformed-payload error. The final full root rerun is recorded with the commit evidence below.

The storage cleanup concern is unchanged: mutation intents and linked history remain conservatively retained until a later design proves no activation, exhaustion, or finalizer path can reference them.

The final mutation-sensitive evidence adds four controlled PostgreSQL cases (4/4): two concurrent exact audit callers serialize and return one history/event while a differing retry conflicts; terminal-history-first blocks preparation and leaves no hidden intent; intent-insert-first blocks revision then preserves the historical revision, while revision-first blocks and rejects the stale insert; and a mixed stale-maintenance batch commits the valid job's audit/failure while a well-shaped source-invalid UUID job fails without mutating unrelated history. These cases raise the availability database file to 39 tests and explicitly cover the concurrency and batch-isolation findings. The final disposable-PostgreSQL root rerun passed 71 files and 763 tests.

Fix-round commit subject: `fix: atomically exhaust availability recovery`.

## Fix round 3: claimed-lease preparation fence

### RED/GREEN

The first worker RED showed activation composition receiving only the parsed message, so provider mutation preparation had no exact lease fence. After requiring the lease in runner dispatch, the crash matrix intentionally went 0/15 because its direct runtime fixture did not own a claimed job; the fixture now claims the durable activation and all 15 crash/admin cases pass through the production fence. The first trigger-isolation RED also proved that independently seeded fixtures occupied different workspaces; the corrected test creates revisions 1 and 2 in one workspace and proves a revision-1 audit trigger failure cannot stop revision 2.

Fresh focused evidence is: availability PostgreSQL 50/50, jobs PostgreSQL 10/10, worker runner/runtime 66/66, and crash/composition 25/25. The availability file includes six source-matching malformed recovery variants plus controlled lease/concurrency and direct-SQL lifecycle cases.

### Lease fence and canonical lock order

`JobLease` now carries `lockedAt`, which is the per-claim lease token alongside job ID, owner, and attempt. Every success, failure, exhaustion, and production mutation-intent preparation binds it. Worker composition captures the exact claimed lease and exposes no provider-writing prepare path without it.

```text
claimed prepare                       terminal exhaustion
BEGIN                                 BEGIN
lock exact running job                lock exact running job
  id/workspace/provider/connection      id/workspace/provider/connection
  owner/lockedAt/attempt                 owner/lockedAt/attempt
validate activation payload           validate exact payload/recovery shape
lock absence                          lock absence
lock decision                         scan intents in decision/id order
lock terminal history                 lock histories in the same order
create-or-load immutable intent       lock pending finalizers in decision/id order
COMMIT                                audit unresolved intents; fail job; COMMIT
```

Prepare-first blocks exhaustion, commits the intent, and exhaustion then records its linked permanent-failure audit. Exhaustion-first commits job failure, after which the stale prepare rejects before provider access and inserts no intent. Rotated owner and rotated `lockedAt` are also rejected. Finalizer completion now locks absence before replacement, so the pending-A/unresolved-B two-transaction case completes with A completed and B permanently audited without deadlock.

### Strict authorization and database lifecycle

Exhaustion authorizes bulk recovery mutation only for an exact `activate_reviewer_absence` payload with no policy recovery. Serialized reviewer recovery must satisfy its phase, finalizer mapping, provider-effects marker, retryability/error, state/outcome, persistence/event provenance, claimed workspace/provider/connection, absence/revision, decision, actors, replacement, and intent discriminants. Malformed phase, finalizer, effects, top-level state, persistence state, and outcome variants fail the job while leaving pending replacements and intents unchanged.

Migration `0008` remains the highest migration. Its replacement UPDATE trigger makes outcome, actors, intent/source identity, reason, and timestamps immutable. Only `finalizer_pending` may transition to `completed` with null error or `permanent_failure` with a nonblank error; terminal rows cannot change. Direct SQL proves completed-to-permanent and outcome mutation reject, valid pending transitions succeed, and later terminal provenance mutation rejects.

### Maintenance isolation and final verification

Stale exhausted jobs are processed in stable creation/ID order and each atomic exhaustion transaction is isolated. If a real database write throws, an exact-lease fallback visibly fails only that job without replacement mutation, then maintenance continues. A trigger-induced revision-1 audit failure leaves no partial history while revision 2 commits its linked audit and job failure.

Final verification used a disposable PostgreSQL container on a random port and no persistent volume: root unit 57 files/624 tests, root PostgreSQL integration 10 files/117 tests, crash/composition 25/25, full build/type check, package-boundary, Compose rendering, Docker build, `git diff --check`, and both Gitleaks scans pass. The standalone public-boundary command still reports only the two inherited Task 6 report terms documented above.

Fix-round commit subject: `fix: fence reviewer intent preparation by lease`.
