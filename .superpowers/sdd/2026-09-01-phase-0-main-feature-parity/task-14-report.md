# Task 14 Implementation Report

## Status

DONE. Documentation and release evidence now describe the integrated reviewer-availability and routing-recovery behavior, the protected release workflow expects the actual highest migration, and release generation refuses to omit either historical `0005` lineage.

Implementation commit: `8115b442e74a31fd2a087d39a4599bcd7ccb6ac4` (`docs: document reviewer availability parity`).

No pull request, push, tag, publication, or live GitHub operation was performed.

## What changed

- Updated the public overview and documentation index for centralized availability, routing recovery, and required human-review policy.
- Reconciled the architecture guide with the public `contracts`, `application`, provider adapter, database, and reusable UI boundaries.
- Documented workspace timezone and DST validation, UTC storage, half-open intervals, overlap rejection, revisioned activation jobs, edit/cancel concurrency, exact replacement outcomes, durable mutation intent/finalizer recovery, provider permissions, and shadow-mode write freedom.
- Documented recovery from either an existing decision or current GitHub pull-request URL, current-state validation, fresh operator identity, worker-time trusted configuration, and non-disclosing target failures.
- Documented status-first provider revocation, deferred physical cleanup, preemptive tombstones, and safe operator diagnostics.
- Corrected inherited policy wording: the required check enforces a risk-based human-approval count; selected reviewers remain advisory.
- Updated manifest creation, artifact verification, publication verification, workflow arguments, upgrade evidence, and fixtures from the former `0006` release level to `0010_provider_connection_preemptive_revocations.sql`.
- Made manifest generation reject a migration directory missing either `0005_reviewer_availability.sql` or `0005_workspace_scope.sql`.
- Preserved earlier SDD evidence while replacing incidental boundary terms that caused the tracked public-boundary scan to fail.

## TDD evidence

### Release level

Before updating fixtures and workflow behavior, one assertion in each requested suite was changed to `0010` while the old `0006` evidence remained.

```text
pnpm vitest run test/create-release-manifest.test.ts test/release-manifest.test.ts test/verify-release-artifacts.test.ts
```

RED: 3 files failed, 4 tests failed and 27 passed. Failures reported that the generated or supplied manifest still named `0006_decision_outbox.sql` instead of `0010_provider_connection_preemptive_revocations.sql`.

### Historical migration lineages

The new manifest test first created a fixture without `0005_reviewer_availability.sql`.

```text
pnpm vitest run test/create-release-manifest.test.ts -t "requires both historical"
```

RED: the promise resolved instead of rejecting. After the minimal migration-directory guard and two independent missing-lineage fixtures were added, `test/create-release-manifest.test.ts` passed 6/6.

### Previous-release upgrade

The unmodified upgrade harness was run against the integrated tree before changing its expected release level.

```text
bash scripts/test-previous-release-upgrade.sh
```

RED after successful migration: `Expected highest migration 0006_decision_outbox.sql, found 0010_provider_connection_preemptive_revocations.sql`.

After updating it to assert `0010` and the exact ordered pair of historical `0005` names, the same harness passed. It migrated representative previous-release data through:

```text
0005_reviewer_availability.sql
0005_workspace_scope.sql
0006_decision_outbox.sql
0007_workspace_reviewer_availability.sql
0008_reviewer_mutation_intents.sql
0009_provider_connection_revocations.sql
0010_provider_connection_preemptive_revocations.sql
```

### Protected workflow

The workflow was temporarily restored to its stale migration argument after adding a regression that requires the current argument at both manifest creation and publication verification.

```text
pnpm vitest run test/workflow-release.test.ts -t "uses the current database migration"
```

RED: expected two occurrences and found none. Restoring both `0010` arguments made the workflow suite pass 6/6.

## Final verification

Post-commit release and package-artifact batch:

```text
pnpm vitest run \
  test/create-release-image-metadata.test.ts \
  test/create-release-manifest.test.ts \
  test/release-manifest.test.ts \
  test/verify-release-artifacts.test.ts \
  test/publish-release-artifacts.test.ts \
  test/workflow-release.test.ts \
  test/package-artifacts.test.ts \
  test/package-artifacts-isolation.test.ts
```

PASS: 8 files, 67 tests.

Additional passing commands:

```text
pnpm check
pnpm check:package-boundary
pnpm check:public-boundary
bash scripts/test-previous-release-upgrade.sh
git diff --check
```

`pnpm check` built all packages and applications, then passed every TypeScript check. The upgrade harness built the current and previous images, migrated its disposable PostgreSQL database, verified health and representative rows, and removed its temporary Compose resources. The package and public boundaries are clean. The two-architecture dry-run below also exercised the Docker build path.

## Regenerated dry-run release evidence

The existing release commands packed all seven public packages, built a `linux/amd64` plus `linux/arm64` OCI archive, derived normalized metadata from the archive, generated the manifest and release notes, generated checksums, and ran the strict artifact verifier. The source checkout was clean at `8115b442e74a31fd2a087d39a4599bcd7ccb6ac4`.

```text
version: 0.1.0
gitCommit: 8115b442e74a31fd2a087d39a4599bcd7ccb6ac4
databaseMigration.id: 0010_provider_connection_preemptive_revocations.sql
license: FSL-1.1-Apache-2.0
dry-run artifact timestamp: 2026-09-02T16:00:00.000Z
dry-run future-license timestamp: 2028-09-02T16:00:00.000Z
container.digest: sha256:f30e114629fb924e225afbb957bbeb50fa95be7368d3b29f82706b965578933b
container archive sha256: 97836ffd58e33ddb1a37c3972b50f886bcd3a344fb9d8a1974c28577b5b7a043
release-manifest.json sha256: 529161b01a03093d7a2b52d8b0de3a33f2fda63315d2779c2f108183254ae899
release-notes.md sha256: 556b8e4ffeb6dcae3143c58206cc0142ac6fd6005112b27a4d9fcfeaebc52479
```

Package SHA-256 values:

```text
@triagepilot/application      21a41120fddcbd5e281497bd90618aa5c81599eea32dcdf9cb9ff6ef8e7fcc45
@triagepilot/config           0a980fcbe135ce81dc9c498693c1fd669c41e166a1058b7983e7eb9db6f5bc14
@triagepilot/contracts        1c3a3d3cdc3cde653d4c02ec1ac668d8607f661d2daf2b6be313b2128c64114a
@triagepilot/core             f6ecebc71ea6b90f05fef6c1ba0767a1ec02b6f003d4854cbe3e94a02a0c29a4
@triagepilot/db               80fc68635bcd56b4516b0e3fc9f0cd249c1f120ddd025df1cf1ba187127689f2
@triagepilot/provider-github  e168de162c84300241a6fe242ca52af821d3ba1570e578ff5a33b500b2f5511b
@triagepilot/ui               c7c2ec17046d9993f8edfd2550cf95618b41629ce8621d1d544ee2c1bad128d3
```

The verified local bundle remains outside the checkout at `/tmp/triagepilot-task14-artifacts.YP7B6Q`. The temporary detached worktree and Buildx builder were removed, and the prior `orbstack` builder was restored.

These values are local review evidence only. They are not release publication timestamps or promises about future published bytes. Task 15 must regenerate evidence after its final branch-wide verification/fix state.

## Review fix

The Task 14 review found that the routing-recovery troubleshooting paragraph described expandable pull-request revision groups and a **Run missing pull request** control that the public operations UI does not provide. The paragraph now matches the executable UI: the **Recent routing decisions** table renders one row per recorded decision, row recovery uses **Re-run routing**, and a request without a decision uses **Run missing change request** followed by **Run routing**.

There is no documentation-specific test harness in the repository. The component source and its behavioral suite were therefore used as the executable reference. Verification after the documentation-only correction:

```text
pnpm exec vitest run packages/ui/test/operations-dashboard.test.tsx
PASS: 1 file, 7 tests.

pnpm exec vitest run \
  test/create-release-manifest.test.ts \
  test/release-manifest.test.ts \
  test/verify-release-artifacts.test.ts \
  test/publish-release-artifacts.test.ts \
  test/workflow-release.test.ts
PASS: 5 files, 61 tests.

pnpm check:public-boundary
git diff --check
PASS.
```

The correction does not alter or regenerate the retained dry-run artifact bundle or its recorded hashes.

## Concerns

- The final report commit necessarily follows the exact source commit used for the dry-run bundle. Task 15 must regenerate evidence from the final reviewed branch head rather than reuse these hashes.
- The live test-organization flow was not run because no external GitHub operation is authorized in this task.
- The full branch-wide release gate belongs to Task 15; Task 14 ran the focused release/package batch, build/type checks, boundaries, upgrade harness, and exact local artifact generator/verifier path.
