# Release Checklist

Keep automated evidence separate from the live GitHub acceptance flow. A green CI run does not prove the live flow, and the live result must not be reported unless a real test organization and GitHub App were used.

## Automated Evidence

Run from a clean clone with a disposable PostgreSQL 16 database:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
TEST_DATABASE_URL=postgres://triagepilot:triagepilot@localhost:5432/triagepilot pnpm test:integration
pnpm build
DATABASE_URL=postgres://triagepilot:triagepilot@localhost:5432/triagepilot pnpm db:migrate
docker compose config
docker build .
pnpm check:public-boundary
pnpm smoke:compose
gitleaks detect --source . --no-banner
test -f LICENSE -a -f SECURITY.md -a -f CONTRIBUTING.md -a -f CODE_OF_CONDUCT.md
```

Record the command outputs and identify the authentication, installation-token, organization-scope, delivery deduplication, retry and recovery, shadow and enforce processing, dashboard, and retention tests. Confirm the migration used an empty database, the Compose smoke endpoint returned HTTP 200, the secret and public-boundary scans reported no findings, and pull-request CI did not publish an image.

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
