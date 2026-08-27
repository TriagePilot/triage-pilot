import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("release workflow guardrails", () => {
  it("keeps full checkout history and asserts the previous-release baseline is available in CI", async () => {
    const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

    expect(ci).toMatch(/- uses: actions\/checkout@[0-9a-f]{40}\n\s+with:\n\s+fetch-depth: 0/);
    expect(ci).toContain('git cat-file -e "${TRIAGEPILOT_UPGRADE_PREVIOUS_RELEASE_COMMIT}^{commit}"');
  });

  it("pins gitleaks by digest in CI and release workflows", async () => {
    const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const pinned = /docker:\/\/ghcr\.io\/gitleaks\/gitleaks:v8\.30\.1@sha256:[0-9a-f]{64}/;

    expect(ci).toMatch(pinned);
    expect(release).toMatch(pinned);
  });

  it("enforces exact annotated semver tags and verifies downloaded artifacts before publish", async () => {
    const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

    expect(release).toMatch(/\[\[\s+!\s+"\$GITHUB_REF_NAME"\s+=~\s+\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$\s+\]\]/);
    expect(release).toContain('node scripts/verify-release-artifacts.mjs');
    expect(release).toContain('cd "$GITHUB_WORKSPACE/artifacts"');
    expect(release).toContain('find packages -maxdepth 1 -type f -name \'*.tgz\' -print | sort');
    expect(release).not.toContain('for tarball in artifacts/packages/*.tgz; do');
    expect(release).toContain('mapfile -t package_tarballs < <(node --input-type=module');
  });
});
