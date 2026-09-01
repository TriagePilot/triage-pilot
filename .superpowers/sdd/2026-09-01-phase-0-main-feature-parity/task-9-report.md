# Task 9 Report: Dispatch Availability Jobs and Recover Finalizers

## Status

Task 9 is complete. Claimed reviewer-absence activation jobs now validate their database-owned scope before any workspace repository, provider credential, or adapter is composed. Activation calls the Task 8 use case, persists immutable mutation intent before provider mutation, and resumes only the mapped pending finalizer after terminal history exists. Shadow behavior remains write-free.

The implementation adds migration `0008_reviewer_mutation_intents.sql`. Released migrations `0001` through `0006` were not edited; `0007` was also left unchanged. Because `0008` is now the highest migration, Task 14 must start at `0009` or later and must not reuse or reorder `0008`.

## RED

Tests were added before each implementation slice and failed for the intended missing behavior:

- the database intent contract failed because `prepareMutationIntent` and `loadMutationIntent` did not exist;
- concurrent prepare and replacement-linkage tests failed because no atomic immutable record or exact replacement provenance existed;
- worker processor tests failed because the activation processor did not exist;
- five runner dispatch tests failed because `activate_reviewer_absence` was unsupported;
- runtime and composition tests failed because the reviewer-availability service factory and claimed-scope guards were absent;
- the first complete integration run exposed nine expected migration-list, schema, and direct-replacement fixture mismatches.

Each RED was narrow and was followed by the smallest implementation or fixture change needed to establish the new contract.

## GREEN

- Durable intent and availability database tests: 22/22.
- PostgreSQL job tests, including activation recovery bounds and stale leases: 10/10.
- Worker availability processor, runner, and runtime service unit tests: 8/8, 32/32, and 30/30.
- Real-PostgreSQL crash matrix: 4/4.
- Self-hosted worker composition: 10/10.
- Complete PostgreSQL integration suite: 89/89.
- Default unit suite: 609 passed with 111 expected database-dependent skips.
- Root build and type checks, package boundary, container build, `git diff --check`, and redacted Git-history and working-directory secret scans passed.

The standalone public-boundary diagnostic still reports only the two committed Task 6 report findings already present at the base revision. Its unit gate passed, and Task 9 introduced no new finding.

## Storage design

`reviewer_mutation_intents` is provider-neutral durable storage with a database UUID identity. Its complete unique key is `(workspace_id, provider_connection_id, absence_id, absence_revision, decision_id)`. Scoped foreign keys bind the workspace, provider connection, absence revision, decision, and repository. The immutable row also stores provider kind, repository identity, durable change-request identity, expected head revision, unavailable actor, and selected replacement actor.

`prepareMutationIntent` locks and validates the current absence and decision source, performs `INSERT ... ON CONFLICT DO NOTHING`, then loads the authoritative row. An exact retry returns the same row. A concurrent prepare whose source or actor differs fails closed rather than overwriting or adopting the new proposal. `loadMutationIntent` remains available after absence revision changes and provider-connection suspension so recovery can use the original actor.

`reviewer_replacements.mutation_intent_id` carries the exact source link. New `replaced` history requires a non-null link, and persistence checks the full immutable intent source plus replacement actor. Pending-finalizer reads return the same link. Branded, nonblank mutation-intent IDs are parsed at database-to-application and queued-recovery boundaries.

## Intent lifecycle and crash recovery

| Interruption point | Durable state | Exact retry behavior |
| --- | --- | --- |
| Before prepare | No intent and no provider effect | Ordinary selection may run. |
| After prepare, before provider mutation | Immutable intent with exact actor | Load the intent and revalidate the current request; do not select a new actor. |
| After DELETE, before POST | Intent plus partially changed provider state | Re-inspect provider state, avoid the completed DELETE, and POST only the stored actor. |
| After POST, before history persistence | Intent plus completed provider effect | Re-inspect, repeat no provider effect, and persist linked terminal history. |
| After terminal history, before finalizer | Linked `finalizer_pending` replacement | Replay only the mapped finalizer; perform no provider inspection, DELETE, or POST. |
| After finalizer, before completion | Linked pending row plus `complete_replacement` recovery | Persist only the terminal replacement state. |

The crash matrix used a stateful provider double and a disposable PostgreSQL instance. It proves process death after prepare, between DELETE and POST, after POST but before persistence, and after terminal persistence. Every retry retains the same mutation intent and actor and never repeats an already completed provider effect.

Intents are retained through terminal replacement persistence and all pending-finalizer phases, including after absence revise, cancel, or provider-connection suspend. No activation-path cleanup was added. Later retention work may retire intents only after neither activation nor finalizer recovery can reference them.

## Recovery validation and phase semantics

`ReviewerReplacementFinalizerRecovery` remains separate from policy-check recovery and is runtime validated before dispatch. The runner rejects incomplete phases, invalid timestamps, blank intent IDs, mixed recovery kinds, or scope that differs from the claimed job.

- `persist_replacement` contains the exact discriminated persistence payload. It performs only database history/cohort/event persistence.
- `run_finalizer` requires a durable replacement identity and a matching pending-finalizer row. It runs only the finalizer mapped by that row.
- `complete_replacement` revalidates the same pending row, then changes only replacement state.

Pending validation compares replacement, decision, outcome, replacement actor, and mutation-intent identities. A null-finalizer provider-effect recovery persists linked terminal history and returns without policy or provider writes. Provider effects already observed as applied are not repeated.

Finalizer policy composition resolves the exact persisted decision and repository in the claimed workspace/provider-connection scope. It can resume after connection suspension, while fresh provider mutation still requires an active connection. Repository owner, name, external ID, provider kind, connection, and workspace are all checked before credential lookup or adapter construction.

## Retry, stale lease, and exhaustion

Existing worker error classification determines retryable versus permanent dispatch failures. Once activation produces recovery, the runner grants a bounded three recovery attempts without resetting the bound on later phases. On valid exhausted recovery, the linked replacement becomes `permanent_failure` with the last error before the job is failed permanently, preserving operator-visible history.

Every success, retry, permanent failure, and recovery transition uses the full claimed lease. A zero-row transition is treated as `StaleJobLeaseError`; a stale worker cannot overwrite a newer claim or completion. Tests cover stale success and stale recovery failure paths.

## Tests and operational hygiene

All database tests used one disposable PostgreSQL container on a random host port with an anonymous volume. No credential value was logged, no persistent database was used, and the container and volume were removed after verification.

Commands run:

```text
TEST_DATABASE_URL=<disposable> pnpm test:integration
TEST_DATABASE_URL=<disposable> pnpm exec vitest run apps/worker/test/availability-runtime.integration.test.ts apps/worker/test/self-hosted-composition.test.ts
pnpm test
pnpm check
pnpm check:package-boundary
pnpm check:public-boundary
docker build -q .
gitleaks git --no-banner --redact .
gitleaks dir --no-banner --redact .
git diff --check
```

## Commit

Single local commit subject:

```text
feat: process reviewer absence activations
```

No push, pull request, tag, publication, dependency change, or persistent database operation was performed.

## Concerns

- Durable mutation intents intentionally have no cleanup path in Task 9. This is the safe recovery posture; later retention work must prove no activation or finalizer reference remains before deletion.
- The standalone public-boundary diagnostic has two inherited Task 6 report findings at the base revision. Task 9 adds no new finding.
- Task 14 must treat `0008_reviewer_mutation_intents.sql` as released history for planning purposes and begin at `0009` or later.
