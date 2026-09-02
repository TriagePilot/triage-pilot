# Task 10 Implementation Report

## Outcome

Implemented the reusable, provider-neutral reviewer-availability UI contract and the authenticated self-hosted HTTP/composition adapter. No schema or migration changed; `0010_provider_connection_preemptive_revocations.sql` remains the highest migration. No push, pull request, tag, or publication was performed.

Implementation commit: `8c6de5fd26f3493c6f2f939b12d973dd5b56b5b0` (`feat: manage reviewer availability in operations`)

## Architecture decisions

- `@triagepilot/ui` owns availability DTOs, the workspace-aware `OperationsApiClient` methods, capability checks, mutation serialization, forms, timezone-aware display, and replacement-history rendering.
- Public identities are `externalActorId`, workspace IDs, absence/decision IDs, and provider-neutral outcomes; the reusable package contains no GitHub URL, installation, OAuth, tenant, or billing concepts.
- `apps/web` owns session/workspace-header enforcement, wall-time parsing, exact validation errors, and self-hosted active-provider-connection resolution.
- The API is mounted below `/api/operations/availability` with separate timezone, absence, cancellation, and replacement-history resources.
- Local wall times accept optional explicit `+/-HH:mm` offsets. Nonexistent times are rejected; ambiguous times require an offset that matches one of the selected IANA zone's possible instants.
- Availability reads fail closed unless exactly one active self-hosted GitHub provider connection exists. Mutations also revalidate the connection in the existing database transaction. Revoked and suspended connections are never treated as active.
- Existing workspace availability persistence provides overlap exclusion, revisioned jobs, optimistic revision enforcement, replacement history, and cross-workspace/provider constraints; Task 10 adds no duplicate persistence model.
- Self-hosted authorization grants availability management only to the authenticated administrator. Configuration remains read-only and routing recovery remains disabled until its planned task.

## TDD evidence

Initial RED:

```text
pnpm vitest run apps/web/test/availability-input.test.ts apps/web/test/availability.test.ts packages/ui/test/reviewer-availability.test.tsx
```

- 3 files failed as expected.
- Parser suite could not collect because the new module did not exist.
- 15 collected tests failed because routes returned 404 and the reusable component/export did not exist.

Concrete client RED:

```text
pnpm vitest run apps/web/test/admin-api.test.ts
```

- 1 of 7 tests failed because availability GET requests unnecessarily sent a JSON content-type header.

Mounted-app RED:

```text
pnpm vitest run apps/web/test/admin-app-mounted.test.tsx apps/web/test/admin-api.test.ts packages/ui/test/operations-dashboard.test.tsx packages/ui/test/effective-configuration.test.tsx
```

- 2 of 13 tests failed because the newly mounted availability table was not yet represented in the accessibility and fetch contracts.

Focused GREEN:

```text
pnpm vitest run apps/web/test/availability-input.test.ts apps/web/test/availability.test.ts apps/web/test/admin-api.test.ts apps/web/test/admin-app-mounted.test.tsx packages/ui/test/reviewer-availability.test.tsx packages/ui/test/operations-dashboard.test.tsx packages/ui/test/effective-configuration.test.tsx
```

- 7 files passed, 34 tests passed, 0 failed.
- Covers IANA validation, DST gaps/folds, explicit offsets, interval errors, authentication, workspace isolation, inactive connections, overlap/revision mappings, concrete HTTP calls, read-only/authorized UI, create/edit/cancel, serialized mutations, retained input, history, session expiry, timezone display, and the pre-existing reviewer quota rendering.

## Verification evidence

```text
pnpm vitest run packages/ui/test apps/web/test
```

- 17 files passed, 1 database-conditioned file skipped.
- 108 tests passed, 7 skipped, 0 failed.

```text
TEST_DATABASE_URL=<disposable database> pnpm vitest run --silent packages/db/test/availability.integration.test.ts apps/web/test/self-hosted-composition.test.ts
```

- 2 files passed, 81 tests passed, 0 failed.
- The disposable database was created and removed by the repository test harness; the persistent Compose database was not modified.

```text
pnpm test
```

- 60 files passed, 14 database-conditioned files skipped.
- 649 tests passed, 187 skipped, 0 failed.

```text
pnpm check
pnpm check:package-boundary
git diff --check
```

- Monorepo production build completed, including the Vite web bundle.
- All workspace TypeScript checks passed.
- Package-boundary and whitespace checks passed.

## Residuals

- No known Task 10 blocker or deferred behavior.
- The repository-wide non-database test command intentionally skips integration suites without `TEST_DATABASE_URL`; the availability and self-hosted composition suites were run separately against disposable PostgreSQL as recorded above.

## Independent-review fix round 1

Review-fix commit: `488f7b8c370509ccc1388db99147edcb0f38a4cf` (`fix: isolate reviewer availability workspace state`)

Addressed both Important findings:

- `ReviewerAvailability` now keys its stateful implementation by `workspace.id`. A workspace change synchronously replaces every cached projection, draft, pending confirmation, and error before the next workspace is painted. This covers both API-fetched data and complete initial props.
- Timezone mutation is blocked while an absence edit is active. Beginning an edit derives and includes the exact UTC offsets for both persisted instants, so submitting an untouched edit has explicit DST semantics and cannot reinterpret the wall times in another zone.

Review-fix RED:

```text
pnpm vitest run packages/ui/test/reviewer-availability.test.tsx
```

- 3 tests failed as expected: fetched workspace A remained visible during the synchronous switch to B, complete B initial props retained A indefinitely, and timezone remained editable while edit payloads omitted UTC offsets.

Review-fix GREEN and focused gate:

```text
pnpm --filter @triagepilot/ui build
pnpm vitest run packages/ui/test/reviewer-availability.test.tsx packages/ui/test/operations-dashboard.test.tsx packages/ui/test/effective-configuration.test.tsx apps/web/test/admin-app-mounted.test.tsx apps/web/test/admin-api.test.ts apps/web/test/availability.test.ts apps/web/test/availability-input.test.ts
pnpm --filter @triagepilot/web check
pnpm check:package-boundary
git diff --check
```

- 7 files passed, 37 tests passed, 0 failed, with no warnings.
- Public UI build, web type-check, package-boundary, and whitespace checks passed.
- No backend, API, persistence, migration, or authorization behavior changed in this fix round.
