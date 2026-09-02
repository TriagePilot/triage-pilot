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

## Fix round 4: provider mutation lease fence and exact exhaustion recovery

### RED/GREEN evidence

The RED run added two production-path provider interleavings, two fully shaped phase-invalid recoveries, nine malformed persistence/event variants, and two policy-success-after-intent recoveries. It failed 15 tests and passed 65: both provider races reached the unfenced write path, non-null persistence was accepted for both finalizer-only phases, all nine malformed persistence payloads authorized exhaustion, and both legitimate intent-retaining recoveries were rejected.

The same focused command is now 80/80:

```text
TEST_DATABASE_URL=<disposable> pnpm exec vitest run apps/worker/test/availability-runtime.integration.test.ts packages/db/test/availability.integration.test.ts
```

The wider availability application, processor, runner, runtime, composition, and jobs slice is 153/153:

```text
TEST_DATABASE_URL=<disposable> pnpm exec vitest run packages/application/test/reviewer-availability.test.ts apps/worker/test/availability-processor.test.ts apps/worker/test/runner.test.ts apps/worker/test/runtime-services.test.ts apps/worker/test/runtime-services.integration.test.ts apps/worker/test/self-hosted-composition.test.ts packages/db/test/jobs.test.ts packages/db/test/jobs.integration.test.ts --reporter=dot
```

### Provider-write serialization boundary

The provider mutation boundary now starts a transaction, locks the exact running job row by job ID, workspace, provider, connection, owner, `lockedAt`, and attempt, revalidates the activation absence/revision, performs the provider reconciliation while retaining that row lock, and commits only after the provider call returns. Every provider-writing path, including durable-intent resume, passes through this boundary.

If exhaustion commits first, the stale worker cannot acquire a valid row and performs zero DELETE/POST calls. If mutation acquires the row first, exhaustion remains blocked until the provider call finishes; only then may it fail the job. The provider-count tests pause immediately before the production boundary and inside the real fake-provider DELETE handler, respectively, proving both controlled orderings against actual provider mutations rather than stopping at intent preparation.

This deliberately holds the exact job-row lock across provider I/O. It is the serialization point that prevents a job from becoming failed or lease-invalid while its provider write is in progress. Existing durable intent preparation, provider reconciliation idempotency, crash resumption, multi-intent exhaustion atomicity, exact scope validation, and shadow-mode write-free behavior remain unchanged.

### Exact exhaustion payload authorization

Database exhaustion now requires every canonical top-level, job, persistence, and event key. Persistence is permitted only for `persist_replacement`; `run_finalizer` and `complete_replacement` require null persistence. Persist payloads require the exact provider/source/provenance mapping, nonblank decision/head/actor/reason and event identity strings, canonical ordered ISO dates, event time equality, mapped state/error/null conditions, correct cohort marker, and exact event scope.

Non-mutating outcomes still require a null replacement actor but may retain a UUID durable intent. Both `run_finalizer` and `complete_replacement` policy-success-after-intent payloads are accepted, allowing exact pending rows to become visibly terminal when the stale job exhausts. Malformed persistence and fully shaped phase-invalid persistence fail only the job and leave intents and pending rows unchanged.

### Final verification

- Correctly bounded root PostgreSQL run: `TEST_DATABASE_URL=<disposable> pnpm test --maxWorkers=2 --minWorkers=2 --reporter=dot` — 71 files, 789/789 tests.
- An initial default-parallel root run passed 782/789 and timed out seven database tests at the five-second limit. Running those seven files serially with `--maxWorkers=1 --minWorkers=1` passed 135/135; the bounded full rerun above then passed, confirming load contention rather than a functional failure.
- `pnpm check`, `pnpm build`, `pnpm check:package-boundary`, and `git diff --check` passed.
- `docker build .` passed.
- The tracked public-boundary unit gates passed 15/15. The standalone diagnostic continues to report only the two inherited Task 6 report findings and this round adds none.
- No migration changed; `0008` remains highest. Tests used a disposable PostgreSQL container on a random port with no persistent volume, and no persistent database was touched.

Round-4 commit: `f8e8576963c10f3c6e767440c3324ededea52849` (`fix: fence reviewer provider writes by lease`). No push or pull request was created.

## Fix round 5: bounded live provider authority

### RED evidence

The first disposable-PostgreSQL RED run failed 10 of 91 tests. An old claim behind a newer claim returned success and inserted false terminal history, each of revise/cancel/suspend allowed the production provider path to continue, a hung provider call exceeded the five-second test deadline, and five fully shaped persistence variants authorized intent-wide exhaustion with a mismatched decision, head, repository, change request, or replacement actor. The already-enforced unavailable-actor check remained green.

A stronger timeout RED then made the fake provider ignore cancellation until explicitly released. Returning a deadline error to the caller still left the transaction callback awaiting that promise, retained the PostgreSQL lock, and caused the release assertion to time out. The in-transaction race was added only after that failure. A final compatibility RED proved that exact intent-backed `permanent_failure` persistence was rejected by an over-strict replacement-actor comparison.

### Obsolete claim and live activation authority

Exact-lease rejection is now the provider-neutral `obsolete_claim` classification. The application rethrows it as claim-control flow, so it cannot become a permanent provider outcome, cannot set `providerEffectsApplied`, and cannot persist replacement history or an event. A controlled old-claim/new-claim application-path test proves zero DELETE/POST, no replacement row, and no mutation of the newer running claim.

The actual provider boundary now locks and validates in this order:

```text
exact running job lease
  -> current reviewer absence ID and revision with scheduled status
  -> matching provider connection with active status
  -> bounded provider reconciliation
```

All rows are scoped by workspace, provider, and provider connection. The three administrative interleavings pause after durable intent preparation but before the provider boundary, then revise, cancel, or suspend. In every case the boundary rejects the now-invalid live authority, performs zero DELETE/POST, writes no false terminal history, and retains the immutable intent for the valid recovery path.

### Bounded transaction and external-system boundary

Provider reconciliation has a configurable positive deadline and uses 60 seconds by default. PostgreSQL lock timeout is bounded by the same deadline, with a one-second-later idle-transaction safety limit. The provider promise is raced both inside the transaction and at the caller boundary. When the deadline expires, the transaction callback rejects and releases its row locks and pooled connection even if the original provider promise does not settle.

The authority carries an `AbortSignal` plus a transaction-backed `assertActive`. The GitHub adapter checks both immediately before every reconciliation GET, DELETE, and POST, passes the signal into the requester, and the transaction revalidates after reconciliation. Once authority ends, a detached non-cooperative promise retains only a revoked signal and cannot start a later provider request. The controlled hung-request test releases that detached promise after PostgreSQL exhaustion has already acquired the former lock and proves zero late writes.

No local protocol can recall an HTTP mutation already accepted by an external provider. Cancellation therefore leaves a narrow, explicit unknown-result boundary for an already in-flight DELETE or POST. The immutable mutation intent, provider-state inspection, and idempotent remove/re-request reconciliation are the replay mechanism for that case. A database-session failure before a later request is detected by `assertActive`; a failure while one request is already in flight has the same external ambiguity and is recovered from the durable intent rather than recorded as false terminal history.

### Exact persistence-to-intent authorization

Persist-phase exhaustion loads the named intent under the exact workspace/provider/connection/absence/revision scope and now also binds decision, expected head revision, external repository identity, change-request identity, unavailable actor, and the selected replacement actor for a `replaced` outcome. Fully shaped mismatches for all source and scope fields fail only the job and leave the entire activation scope unchanged.

Canonical non-mutating and permanent-failure persistence still carries a null output replacement actor. Those outcomes are bound by the exact named immutable intent plus all other source fields; the parser continues to require null output actor fields. A dedicated exact permanent-failure case proves legitimate intent-backed exhaustion remains accepted and visibly audited.

### Final verification

All database work used one disposable PostgreSQL 16 container with tmpfs storage and a random host port. No persistent database or credential was used.

- Focused runtime and availability PostgreSQL: 2 files, 97/97 tests.
- Full Task 9 application/processor/runner/runtime/jobs/composition slice: 10 files, 251/251 tests.
- Provider adapter plus focused non-database application/worker slice: 5 files, 181/181 tests.
- Bounded root run with disposable PostgreSQL: 71 files, 807/807 tests.
- `pnpm check`, `pnpm build`, `pnpm check:package-boundary`, Docker Compose rendering, `docker build -q .`, and `git diff --check` passed.
- Tracked public-boundary tests passed 15/15. The standalone diagnostic still reports only the two inherited Task 6 report terms and this round adds no finding.
- Git-history and working-tree Gitleaks scans passed with no leaks.

Migration `0008_reviewer_mutation_intents.sql` remains the highest migration and no migration file changed. Canonical lock order, SQL lifecycle/provenance immutability, per-job maintenance isolation, exact recovery shape, multi-intent atomicity, idempotency, workspace/provider isolation, and shadow-mode write-free behavior remain covered by the green root suite.

Round-5 implementation commit: `a750f9c` (`fix: bound reviewer mutation authority`). No push, pull request, tag, publication, or persistent-database operation was performed.

## Task 9 breaker-resolution

### Status-first revocation and canonical protocol

GitHub `installation.deleted` now performs a security-critical local revocation, not a physical delete. The workspace repository transaction takes the provider-projection workspace advisory lock, locks the exact workspace/provider/external-connection row, inserts a durable tombstone bound to that row's immutable internal ID, changes the row from `active` or `suspended` to permanent `revoked`, and commits. It never locks or deletes job, absence, replacement, intent, repository, or receipt children. Temporary GitHub suspension remains the distinct `suspended` state; suspension updates only an active connection and cannot overwrite `revoked`.

The canonical concurrency protocol is:

```text
provider mutation authority: exact job -> exact absence -> exact provider connection
provider lifecycle projection: workspace advisory lock -> exact provider connection
deferred cleanup: exact tombstone -> exact revoked provider connection,
                  but only when no queued/running job references that internal ID
```

The provider mutation and revocation paths may wait on the provider row, but revocation holds no child lock, so they cannot form the former parent/child cycle. If revocation commits before provider authority reaches the connection row, the active-status check rejects authority and the worker performs zero provider writes or terminal-history writes. If provider authority already holds the connection row, revocation cannot commit until that bounded authority finishes; consequently no new provider request can start after the revocation commit.

Physical deletion is retryable maintenance work. Worker startup and every maintenance cycle scan at most 25 pending tombstones in stable order. Each attempt locks one tombstone, deletes only its immutable revoked connection ID after all jobs for that generation leave `queued`/`running`, lets existing foreign keys cascade that old generation's dependents, and then records `cleanup_completed_at`. A lock, statement, or connection failure leaves the durable tombstone pending; the maintenance cycle remains available and retries it next time. Cleanup is idempotent when the connection is already absent or the tombstone is already complete.

Tombstones remain after cleanup as the anti-resurrection guard. All ordinary delivery, activation, snapshot, suspension, and repository-update paths for that same workspace/provider/external ID fail closed. A legitimate reconnect must arrive with a different immutable external installation ID, which creates a distinct internal connection generation; old cleanup is keyed by the revoked internal ID and cannot delete or mutate the reconnect. No behavior depends on webhook delivery order.

### Migration decision

A new `0009_provider_connection_revocations.sql` migration is necessary because permanent anti-resurrection state must survive physical deletion of `provider_connections`. It adds `revoked` to the allowed provider-connection statuses and adds the durable tombstone table with both the immutable revoked internal ID and a unique workspace/provider/external-ID guard. The tombstone deliberately has no foreign key to the physical connection, so cascade cleanup cannot erase the revocation evidence. The original provider-connection external-ID uniqueness remains intact. Migrations `0001` through `0008` are unchanged; `0009_provider_connection_revocations.sql` is now the highest migration and the fresh/upgrade/schema tests include it.

### RED evidence

The first unit RED was:

```text
pnpm vitest run apps/worker/test/maintenance.test.ts apps/web/test/webhooks.test.ts --reporter=dot
```

It failed 3 of 29 tests: cleanup was absent at startup and during maintenance, and authoritative installation creation had no explicit generation semantics.

The first disposable-PostgreSQL command was:

```text
TEST_DATABASE_URL=<disposable> pnpm vitest run packages/db/test/schema.integration.test.ts packages/db/test/deliveries.integration.test.ts apps/worker/test/availability-runtime.integration.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1
```

Schema/delivery produced the intended 3 failures and 9 passes: physical deletion removed the row, the reconnect-generation contract was absent, and migration `0009` did not exist. The worker file initially failed collection because that app test directly imported Kysely through a pnpm-inaccessible package path; the test-only lock observation was corrected to use the existing typed database handle, without production changes.

The corrected worker RED was:

```text
TEST_DATABASE_URL=<disposable> pnpm vitest run apps/worker/test/availability-runtime.integration.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1
```

It failed 2 of 24 tests. With provider authority holding the job and waiting for the locked absence, physical deletion did not settle within 500 ms; in the reverse ordering it removed the connection instead of leaving durable revocation.

The delayed-suspension RED was:

```text
TEST_DATABASE_URL=<disposable> pnpm vitest run packages/db/test/deliveries.integration.test.ts -t 'durably revokes' --reporter=dot --maxWorkers=1 --minWorkers=1
```

It failed the selected test, with 9 skipped, because a late suspension changed `revoked` back to `suspended` and replaced its metadata.

The initial reconnect design allowed authoritative `installation.created` to supersede a tombstone for the same external ID. The final fail-closed ruling was first captured with:

```text
pnpm vitest run apps/web/test/webhooks.test.ts --reporter=dot
```

It failed 1 of 24 tests because the route still emitted `establishNewGeneration: true`; that signal and the supersede API/schema were then removed before final GREEN.

### GREEN and operational evidence

All database verification used a disposable PostgreSQL 16 container with tmpfs storage on a random host port. No persistent database was touched.

- Webhook and maintenance unit slice: 2 files, 29/29 tests.
- Schema, delivery/reconnect/cleanup, and controlled deadlock runtime slice: 3 files, 36/36 tests. The runtime file contributes both orderings and asserts prompt revocation, zero provider writes, no false history or intent, and permanent revoked status.
- Final delivery fail-closed/reconnect slice: 10/10 tests. It proves same-ID creation remains blocked before and after physical cleanup, a new external ID remains active, pending old work delays cleanup, and repeated cleanup is idempotent.
- Final maintenance retry slice: 5/5 tests; a failed cleanup attempt is retried on the following cycle while heartbeat/outbox work continues.
- Root PostgreSQL run: `TEST_DATABASE_URL=<disposable> pnpm test --reporter=dot --silent --maxWorkers=2 --minWorkers=2` — 71 files, 811/811 tests.
- `pnpm build` passed. `pnpm check` passed its full rebuild and all package type checks.
- `pnpm check:package-boundary`, `docker compose config --quiet`, `docker build .`, and `git diff --check` passed.
- `gitleaks git --no-banner --redact .` scanned 122 commits with no leaks; `gitleaks dir --no-banner --redact .` scanned the working tree with no leaks.
- The tracked public-boundary tests passed in the 811-test root run. The standalone `pnpm check:public-boundary` still exits nonzero only for the inherited Task 6 report terms `commercial` and `saas`; this breaker resolution adds no finding.

Implementation commit: `0c6ebd8a2b6519e72036604f81eb5bacca7cec80` (`fix: revoke provider connections before cleanup`).

### Residual external API ambiguity

The prior accepted external boundary remains: an HTTP mutation already accepted by GitHub cannot be recalled if authority is lost while that request is in flight. The bounded authority signal prevents later controllable requests, and durable intent plus idempotent reconciliation handles the unknown result.

GitHub installation lifecycle payloads expose the external installation ID but no TriagePilot internal generation token. This implementation assumes a real reinstall receives a new immutable installation ID, which is the expected GitHub lifecycle. It does not treat delivery order or a repeated `installation.created` action as proof that a tombstoned ID is a new generation: doing so would let a delayed old `installation.deleted` revoke a new connection. If GitHub ever reuses an installation ID, the system intentionally stays disconnected until explicit operator intervention proves the new identity and reconciles the tombstone.

No push, pull request, tag, publication, dependency change, released-migration edit, or persistent-database operation was performed.
