# Release Checklist

Keep automated evidence separate from the live GitHub acceptance flow. A green CI run does not prove the live flow, and the live result must not be reported unless a real test organization and GitHub App were used.

Tagged releases must start from an annotated `vX.Y.Z` tag whose target commit already carries the same `X.Y.Z` in the root `package.json`, every published package manifest, and the Dockerfile `TRIAGEPILOT_VERSION` build argument. The public release workflow builds, tests, packs, scans, and verifies one exact tag commit before publishing anything.

Original TriagePilot code is released under `FSL-1.1-Apache-2.0` with the notice `Copyright 2026 Miroslav Babjak`. Each version becomes available under Apache License 2.0 on the second anniversary of the date that version is made available. Public Git commits, package publication, image publication, and release publication can each establish availability; artifact metadata records artifact publication provenance and does not redefine or delay an earlier source-availability date recorded in public Git history. Third-party components keep their own licenses, and required third-party notices must be preserved.

## Automated Evidence

Run from a clean clone with a disposable PostgreSQL 16 database:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
TEST_DATABASE_URL=postgres://triagepilot:triagepilot@localhost:5432/triagepilot pnpm test:integration
pnpm build
DATABASE_URL=postgres://triagepilot:triagepilot@localhost:5432/triagepilot pnpm db:migrate
pnpm check:package-boundary
docker compose config
docker build --tag triagepilot-release-check:production .
node scripts/verify-production-image.mjs triagepilot-release-check:production
bash scripts/test-previous-release-upgrade.sh
pnpm check:public-boundary
pnpm smoke:compose
gitleaks detect --source . --no-banner
test -f LICENSE -a -f SECURITY.md -a -f CONTRIBUTING.md -a -f CODE_OF_CONDUCT.md
```

Record the command outputs and identify the authentication, installation-token, organization/workspace scope, delivery deduplication, routing recovery, reviewer availability and replacement finalizer, status-first connection revocation, shadow and enforce processing, dashboard, and retention tests. Confirm the image verifier reported a non-root compiled runtime without source or development tooling, the migration used an empty database, the previous-release upgrade reached `0010_provider_connection_preemptive_revocations.sql` and recorded both `0005_reviewer_availability.sql` and `0005_workspace_scope.sql`, the Compose smoke endpoint returned HTTP 200, the secret and public-boundary scans reported no findings, and pull-request CI did not publish an image.

Use a fresh disposable PostgreSQL server for release evidence; do not point the integration gate at a persistent deployment database. On a constrained local Docker runtime, database-backed Vitest files may exhaust the shared server when run in parallel. In that environment, retain the unconstrained result as diagnostic evidence and rerun the database-backed batch against a fresh disposable server with `--maxWorkers=1 --minWorkers=1`. This is local runner guidance, not permission to replace or weaken the canonical `pnpm test` command in CI or the final release record.

The tag workflow also produces `artifacts/release-manifest.json`, `artifacts/release-notes.md`, `artifacts/container/triagepilot-X.Y.Z.oci.tar`, and `artifacts/checksums.txt`. The manifest is the release contract for consumers and must contain:

- `version`: the synchronized package and image version from the `vX.Y.Z` tag.
- `gitCommit`: the exact commit built by the workflow.
- `license`: `FSL-1.1-Apache-2.0`.
- `publishedAt`: the artifact publication timestamp chosen once by the release workflow.
- `futureLicenseEffectiveAt`: the Apache 2.0 artifact future-license timestamp, derived as the second anniversary of `publishedAt`.
- `packages`: the seven public package tarballs, sorted by package name, each with the package `publishedAt`, package `futureLicenseEffectiveAt`, and SHA-256 digest.
- `contracts.sha256`: the digest of the packed `@triagepilot/contracts` tarball.
- `databaseMigration.id`: the highest public migration shipped by `@triagepilot/db`.
- `container.digest`, `container.imageVersion`, `container.publishedAt`, and `container.futureLicenseEffectiveAt`: the OCI image digest, matching image version annotation, artifact publication timestamp, and matching artifact future-license timestamp.

The publishable OCI archive and the GHCR image digest must be one OCI index with exactly `linux/amd64` and `linux/arm64` images. The index and both platform manifests include Buildx OCI annotations for `org.opencontainers.image.version`, `org.opencontainers.image.licenses=FSL-1.1-Apache-2.0`, `org.opencontainers.image.revision`, `org.opencontainers.image.created`, and `org.triagepilot.future-license-effective-at`; Docker image labels are useful compatibility metadata but are not the release attestation source. `container/metadata.json` is reduced to deterministic digest, descriptor, and annotation evidence, while attached image provenance is disabled so invocation timestamps cannot change the immutable OCI index digest on a workflow replay. After successful publication, the OIDC-protected job records signed SLSA provenance for the stable release bundle in GitHub's artifact-attestation store. The protected publication job copies the verified OCI layout to GHCR with ORAS, resolves the tag digest, verifies the digest-bound remote index annotations, and cross-checks both remote platform image configs. Release notes must repeat the license identifier, artifact publication timestamp, artifact future-license timestamp, source commit, migration, and package/image digests so operators can distinguish artifact provenance from source availability.

Publish from the protected `public-release` environment only after those artifacts exist and the temporary consumer install succeeds. The annotated tag's immutable tagger timestamp is the workflow's single `publishedAt` and `SOURCE_DATE_EPOCH`, so a fresh rerun for the same tag rebuilds the same artifact inputs. The publication step is replay-safe: registry artifacts are completed before the GitHub release is finalized; an existing GitHub release, GHCR image tag, or npm package version is accepted only when its notes, attached manifest/checksum digests, digest-bound annotations/labels, or downloaded package bytes match the verified artifacts. Missing `release-manifest.json` or `checksums.txt` assets are uploaded on retry, while immutable mismatches stop the retry instead of overwriting remote state. npm publication uses the protected job's OIDC identity and npm trusted publishing, without a long-lived write token.

At the rendered-configuration validation boundary, the smoke shell owns and supplies the four generated secret-mount source paths. The validator treats those paths as expected binds but independently derives the canonical physical repository root from its own module location; no build-root value crosses the CLI boundary. Before starting a container, it requires the exact PostgreSQL and web healthchecks, no worker healthcheck, and no Compose lifecycle or develop/watch hooks. The later health-URL mode accepts only Docker's published loopback address and validates that address before using it.

## Phase 0 Release Evidence Contract

Before tagging, run the automated gate from a clean detached checkout: frozen install, exact parallel tests, build, boundary checks, container/Compose/upgrade checks, secret scan, and whitespace check. Artifact verification must install all seven packed packages by name through a temporary registry, compile and import them from the consumer, and reject lockfile references using `workspace:`, `link:`, `file:`, Git, or source paths. Dry-run output is review evidence only and must not be presented as the future tag's published digests or timestamps.

After review and explicit approval, the protected tag workflow is authoritative. It takes the tag target as `gitCommit`, synchronizes `version` with the tag, chooses `publishedAt` once, derives the future-license timestamp, identifies the highest shipped public migration, and produces `release-manifest.json`, release notes, OCI archive, and checksums. Record the resulting version, commit, migration, package SHA-256 values, OCI digest, license identifier, and timestamps from those workflow outputs; their byte-level annotations and checksums must agree.

For the current candidate, the expected highest migration is `0010_provider_connection_preemptive_revocations.sql`. The manifest generator also checks that both historical `0005` filenames are present before it writes evidence. Pass the same `0010` filename to manifest creation, artifact verification, publication verification, and the protected workflow; a stale value must fail before publication.

The exact parallel `pnpm test` gate packages in a disposable source workspace, so it does not mutate root `dist` entries used by concurrent suites. Do not tag until the clean-checkout gate passes, review is complete, and explicit release approval is granted.

## Live Test-Organization Flow

Use a disposable GitHub App and organization that are safe for acceptance testing:

1. Configure TriagePilot for the test organization and install the App on exactly two selected repositories in that organization.
2. Keep one repository's `.github/triagepilot.yml` in `mode: shadow`.
3. Deliver one supported pull-request webhook, then redeliver that same delivery.
4. Verify the duplicate delivery produces one webhook receipt, one job, and one complete routing decision, with no GitHub write.
5. Open a pull request that changes only `.github/triagepilot.yml` to `mode: enforce`; verify its event remains governed by the shadow configuration at its base and performs no GitHub write.
6. Merge that configuration change. For a different pull request, pause the worker, deliver an event at head A, advance the pull request to head B, then resume the worker. Verify a permanent action failure is recorded and no check, comment, reviewer, or approval write is made for the delayed job.
7. Deliver a new supported event for head B and verify the intended GitHub action and recorded successful outcome. Confirm the check targets head B and any policy approval is pinned to head B.
8. Verify the second selected repository is discovered and can be processed within the same configured organization.
9. Remove the test App installation and delete or rotate every acceptance credential.

Record the organization, repositories, delivery IDs, observed decision IDs and action outcome, and cleanup result in the release evidence. If this flow was not run, state that explicitly and leave live acceptance incomplete.
