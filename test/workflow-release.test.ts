import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("release workflow guardrails", () => {
  it("declares the canonical GitHub repository in every OIDC-published npm package", async () => {
    for (const packageDirectory of ["contracts", "config", "core", "application", "db", "provider-github", "ui"]) {
      const manifest = JSON.parse(
        await readFile(new URL(`../packages/${packageDirectory}/package.json`, import.meta.url), "utf8"),
      );
      expect(manifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/TriagePilot/triage-pilot.git",
        directory: `packages/${packageDirectory}`,
      });
    }
  });

  it("keeps full checkout history and asserts the previous-release baseline is available in CI", async () => {
    const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

    expect(ci).toMatch(/- uses: actions\/checkout@[0-9a-f]{40}\n\s+with:\n\s+fetch-depth: 0/);
    expect(ci).toContain('git cat-file -e "${TRIAGEPILOT_UPGRADE_PREVIOUS_RELEASE_COMMIT}^{commit}"');
  });

  it("waits for the upgrade database healthcheck rather than its temporary initialization server", async () => {
    const upgrade = await readFile(new URL("../scripts/test-previous-release-upgrade.sh", import.meta.url), "utf8");

    expect(upgrade).toContain("compose up -d --wait --wait-timeout 120 postgres");
    expect(upgrade).not.toContain("compose up -d postgres\nwait_for_postgres");
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
    const publishScript = await readFile(new URL("../scripts/publish-release-artifacts.mjs", import.meta.url), "utf8");

    expect(release).toMatch(/\[\[\s+!\s+"\$GITHUB_REF_NAME"\s+=~\s+\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$\s+\]\]/);
    expect(publishScript).toContain('verifyReleaseArtifacts({');
    expect(release).toContain('cd "$GITHUB_WORKSPACE/artifacts"');
    expect(release).toContain('find packages -maxdepth 1 -type f -name \'*.tgz\' -print | sort');
    expect(release).not.toContain('for tarball in artifacts/packages/*.tgz; do');
    expect(release).toContain("%(taggerdate:unix)");
    expect(release).toContain("SOURCE_DATE_EPOCH");
    expect(release).not.toContain("const date = new Date(); date.setUTCMilliseconds(0)");
    expect(release).toContain('artifact_future_license_effective_at="$(ARTIFACT_PUBLISHED_AT="$artifact_published_at" node --input-type=module');
    expect(release).toContain('--build-arg "TRIAGEPILOT_GIT_COMMIT=${{ steps.release_meta.outputs.git_commit }}"');
    expect(release).toContain('--build-arg "TRIAGEPILOT_PUBLISHED_AT=${{ steps.release_meta.outputs.artifact_published_at }}"');
    expect(release).toContain('--build-arg "TRIAGEPILOT_FUTURE_LICENSE_EFFECTIVE_AT=${{ steps.release_meta.outputs.artifact_future_license_effective_at }}"');
    expect(release).not.toContain("--load");
    expect(release).not.toContain("docker save");
    expect(release).not.toContain("docker load --input");
    expect(release).not.toContain("docker push");
    expect(release).toContain("docker/setup-qemu-action@");
    expect(release).toContain("--platform linux/amd64,linux/arm64");
    expect(release).toContain("--provenance=false");
    expect(release).toContain('--metadata-file "$RUNNER_TEMP/buildx-metadata.json"');
    expect(release).toContain("node scripts/create-release-image-metadata.mjs");
    expect(release).toContain('--oci-archive "artifacts/container/triagepilot-${{ steps.release_meta.outputs.version }}.oci.tar"');
    expect(release).toContain('--output "type=oci,dest=artifacts/container/triagepilot-${{ steps.release_meta.outputs.version }}.oci.tar');
    expect(release).toContain("rewrite-timestamp=true");
    expect(release).toContain('--annotation "index,manifest:org.opencontainers.image.licenses=FSL-1.1-Apache-2.0"');
    expect(release).toContain('--annotation "index,manifest:org.opencontainers.image.revision=${{ steps.release_meta.outputs.git_commit }}"');
    expect(release).toContain('--annotation "index,manifest:org.opencontainers.image.created=${{ steps.release_meta.outputs.artifact_published_at }}"');
    expect(release).toContain('--annotation "index,manifest:org.triagepilot.future-license-effective-at=${{ steps.release_meta.outputs.artifact_future_license_effective_at }}"');
    expect(release).toContain('TRIAGEPILOT_ARTIFACT_PUBLISHED_AT="${{ steps.release_meta.outputs.artifact_published_at }}"');
    expect(release).toContain('TRIAGEPILOT_ARTIFACT_FUTURE_LICENSE_EFFECTIVE_AT="${{ steps.release_meta.outputs.artifact_future_license_effective_at }}"');
    expect(release).toContain('--published-at "${{ steps.release_meta.outputs.artifact_published_at }}"');
    expect(release).toContain('node scripts/create-release-notes.mjs');
    expect(release).toContain('release-notes.md');
    expect(release).toContain('oras-project/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d');
    expect(release).toContain("node scripts/publish-release-artifacts.mjs");
    expect(release).toContain("npm install --global npm@11.5.1");
    expect(release).not.toContain("secrets.NPM_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN:");
    expect(release).toContain("attestations: write");
    expect(release).toContain("artifact-metadata: write");
    expect(release).toContain("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
    expect(release).toContain("subject-path: artifacts/**/*");
    expect(publishScript).toContain('"oras", ["cp", "--from-oci-layout-path"');
    expect(publishScript).toContain('"oras", ["resolve", options.imageName]');
    expect(publishScript).toContain('"oras", ["manifest", "fetch", reference]');
    expect(publishScript).toContain('"gh", ["release", "view"');
    expect(publishScript).toContain('"create"');
    expect(publishScript).toContain('"--notes-file"');
    expect(publishScript).toContain('"release", "upload"');
    expect(publishScript).toContain('join(artifactsDir, "release-manifest.json")');
    expect(publishScript).toContain('join(artifactsDir, "checksums.txt")');
  });
});
