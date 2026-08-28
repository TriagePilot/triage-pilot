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
docker build .
bash scripts/test-previous-release-upgrade.sh
pnpm check:public-boundary
pnpm smoke:compose
gitleaks detect --source . --no-banner
test -f LICENSE -a -f SECURITY.md -a -f CONTRIBUTING.md -a -f CODE_OF_CONDUCT.md
```

Record the command outputs and identify the authentication, installation-token, organization-scope, delivery deduplication, retry and recovery, shadow and enforce processing, dashboard, and retention tests. Confirm the migration used an empty database, the previous-release upgrade reached `0006_decision_outbox.sql`, the Compose smoke endpoint returned HTTP 200, the secret and public-boundary scans reported no findings, and pull-request CI did not publish an image.

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

The publishable OCI archive and the GHCR image digest must include Buildx OCI manifest annotations for `org.opencontainers.image.version`, `org.opencontainers.image.licenses=FSL-1.1-Apache-2.0`, `org.opencontainers.image.revision`, `org.opencontainers.image.created`, and `org.triagepilot.future-license-effective-at`; Docker image labels are useful compatibility metadata but are not the release attestation source. The protected publication job copies the verified OCI layout to GHCR with ORAS, resolves the tag digest, verifies the digest-bound remote manifest annotations, and cross-checks the remote image config labels. Release notes must repeat the license identifier, artifact publication timestamp, artifact future-license timestamp, source commit, migration, and package/image digests so operators can distinguish artifact provenance from source availability.

Publish from the protected `public-release` environment only after those artifacts exist and the temporary consumer install succeeds. The publication step is replay-safe: an existing GitHub release, GHCR image tag, or npm package version is accepted only when its notes, digest-bound annotations/labels, or downloaded package bytes match the verified artifacts; immutable mismatches stop the retry instead of overwriting remote state.

At the rendered-configuration validation boundary, the smoke shell owns and supplies the four generated secret-mount source paths. The validator treats those paths as expected binds but independently derives the canonical physical repository root from its own module location; no build-root value crosses the CLI boundary. Before starting a container, it requires the exact PostgreSQL and web healthchecks, no worker healthcheck, and no Compose lifecycle or develop/watch hooks. The later health-URL mode accepts only Docker's published loopback address and validates that address before using it.

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
