# Task 11 Implementation Report

## Outcome

Implemented provider-neutral, workspace-scoped routing recovery and the self-hosted GitHub composition adapter. Recovery validates exactly one target, resolves only active workspace/provider targets, reads current provider state, and inserts a fresh operator routing job without synthesizing or persisting a webhook receipt.

Implementation commit: `53f11babd58db830b4043dd4bac3b361e6a5c928` (`feat: add workspace scoped routing recovery`)

No migration changed; `0010_provider_connection_preemptive_revocations.sql` remains the highest migration. No push, pull request, tag, or publication was performed.

## Architecture decisions

- `@triagepilot/application` owns strict target/current-state validation, non-disclosing unavailable and closed outcomes, lifecycle-aware routing identity, fresh operator delivery/run identity, and recovery job construction.
- The public application request is either a workspace-scoped decision ID or a structured provider-qualified change-request reference. It contains no GitHub URL or installation type.
- `@triagepilot/db` owns active target resolution and direct job insertion. Lookup joins workspace, provider, repository, and provider connection. Enqueue takes the same workspace projection lock as connection lifecycle transitions and revalidates the active connection/repository before insertion.
- A repeated enqueue with the same operator routing key returns the existing job, while each normal recovery request gets a new run ID and therefore a fresh `:operator:<run-id>` routing key.
- Recovery inserts no webhook receipt. The resulting `process_change_request` job follows the existing worker path, so trusted repository configuration is resolved at processing time and existing shadow/enforce behavior remains authoritative.
- `@triagepilot/provider-github` alone parses canonical GitHub pull-request URLs and reads current open/base/head/draft state. GitHub 404 becomes the generic unavailable outcome; malformed provider state fails closed.
- The self-hosted composition translates a GitHub URL into the stored provider-neutral repository identity, creates installation credentials only for the active scoped connection, and performs one provider read. Recovery itself performs no provider mutation in either shadow or enforce mode.
- Revoked or suspended connections are denied both during lookup and again during enqueue. This retains Task 9's status-first revocation/tombstone authority boundary.

## TDD evidence

Initial application/provider RED:

```text
pnpm vitest run packages/application/test/routing-recovery.test.ts packages/provider-github/test/adapter.test.ts
```

- Application test collection failed because `routing-recovery.ts` did not exist.
- 14 GitHub tests failed because URL parsing and current-state inspection did not exist.

Initial PostgreSQL RED:

```text
TEST_DATABASE_URL=<disposable database> pnpm vitest run packages/db/test/routing-recovery.integration.test.ts packages/db/test/workspace-isolation.integration.test.ts
```

- 7 tests failed because `createWorkspaceRoutingRecoveryRepository` did not exist.
- Existing workspace-isolation tests remained green.

Initial self-hosted composition RED:

```text
TEST_DATABASE_URL=<disposable database> pnpm vitest run apps/web/test/self-hosted-composition.test.ts
```

- 2 tests failed because the recovery composition was not present.

Provider-not-found RED:

```text
pnpm vitest run packages/application/test/routing-recovery.test.ts packages/provider-github/test/adapter.test.ts
```

- 2 tests failed because GitHub 404 propagated and the application classified null provider state as malformed rather than unavailable.

Focused GREEN:

```text
TEST_DATABASE_URL=<disposable database> pnpm vitest run --silent \
  packages/application/test/routing-recovery.test.ts \
  packages/db/test/routing-recovery.integration.test.ts \
  packages/db/test/workspace-isolation.integration.test.ts \
  packages/provider-github/test/adapter.test.ts \
  apps/web/test/self-hosted-composition.test.ts
```

- 5 files passed, 110 tests passed, 0 failed.
- Covers strict target parsing, decision/reference lookup, provider qualification, cross-workspace non-disclosure, active/suspended/revoked connection handling, current open/closed/missing state, base/head/draft propagation, unique operator identities, enqueue idempotency, no webhook receipt, canonical GitHub URL parsing, and self-hosted credential/state composition.
- Every PostgreSQL suite used the repository's disposable-database harness; the persistent Compose database was not modified.

## Verification evidence

```text
pnpm check
pnpm check:package-boundary
git diff --check
```

- All public packages and both applications built.
- All workspace TypeScript checks, type tests, package-boundary checks, and whitespace checks passed.

```text
pnpm test -- --silent
```

- 61 test files passed, 15 database-conditioned files skipped.
- 685 tests passed, 196 skipped, 0 failed.
- The skipped routing-recovery/database composition coverage was run separately against disposable PostgreSQL in the 110-test focused gate above.

```text
docker build .
```

- Image build completed successfully as `sha256:15a8b84e6d6fb6fad07c6f7ce3669673fb11254cf45b34e2b0ec45743a427b36`.

## Self-review

- Generic application and database implementation contains no GitHub URL parsing, GitHub request types, installation ID, tenant, OAuth, billing, or hosted-service concepts.
- Every lookup and inserted job is bound to workspace, provider, and provider connection; enqueue revalidates active scope after provider state was read.
- The recovery path has a provider read port and no provider write port. Worker shadow/enforce behavior remains unchanged and the standard routing job path resolves live trusted configuration.
- No migrations, release metadata, unrelated runtime routes, or UI behavior changed.

## Concerns

- No known Task 11 blocker. HTTP authentication/status mapping and reusable recovery controls remain intentionally assigned to Task 12.

## Review-fix round

Review-fix implementation commit: `b8ea4cceaeb6857f37c279f3c13b9a405d8e1e97` (`fix: validate routing recovery boundaries`)

The application boundary now parses decision targets as canonical RFC UUIDs into an internal branded ID before calling `findTarget`. A malformed nonblank decision ID therefore produces `RoutingRecoveryValidationError` and cannot reach a PostgreSQL UUID comparison. Current provider state now accepts only the provider-neutral `open` and `closed` lifecycle values; any other nonblank state is a malformed-provider-response validation error rather than a closed classification.

Review-fix RED:

```text
pnpm exec vitest run packages/application/test/routing-recovery.test.ts --reporter=verbose
```

- 2 tests failed: `not-a-uuid` reached the mocked target and queued a job, and `unexpected` provider state produced `RoutingRecoveryClosedError`.
- The malformed-target case also asserted that `findTarget`, `fetchCurrentState`, and `enqueue` must not be called.

```text
TEST_DATABASE_URL=<tmpfs PostgreSQL container> pnpm exec vitest run \
  apps/web/test/self-hosted-composition.test.ts \
  --reporter=verbose --maxWorkers=1 --minWorkers=1
```

- 1 of 8 tests failed exactly as reviewed: `{ decisionId: "not-a-uuid" }` raised PostgreSQL `22P02` instead of an `invalid_target` application outcome.
- The test harness created and dropped a random database inside a dedicated tmpfs PostgreSQL container; the persistent Compose database was not used.

Review-fix GREEN:

```text
TEST_DATABASE_URL=<tmpfs PostgreSQL container> pnpm exec vitest run \
  packages/application/test/routing-recovery.test.ts \
  packages/provider-github/test/adapter.test.ts \
  packages/db/test/routing-recovery.integration.test.ts \
  packages/db/test/workspace-isolation.integration.test.ts \
  apps/web/test/self-hosted-composition.test.ts \
  --reporter=dot --silent --maxWorkers=1 --minWorkers=1
```

- 5 files passed, 112 tests passed, 0 failed.
- The real composition regression returned `invalid_target`, performed no provider access, inserted no job, and no longer emitted `22P02`.

Review-fix gates:

```text
pnpm check
pnpm check:package-boundary
git diff --check
```

- Workspace build, TypeScript and type-test checks, package-boundary checks, and whitespace checks passed.
- No migration, provider adapter, database query, webhook behavior, configuration timing, or shadow/enforce write behavior changed.

Review-fix concerns: none known. The UUID validation deliberately matches the existing application/database convention for canonical version 1-5 RFC UUIDs with a valid variant; routing decision IDs are generated as version 4 UUIDs by PostgreSQL.
