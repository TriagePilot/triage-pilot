import { describe, expect, it } from "vitest";

import { validateReleaseManifest } from "../scripts/create-release-manifest.mjs";

const publishedPackages = [
  "@triagepilot/application",
  "@triagepilot/config",
  "@triagepilot/contracts",
  "@triagepilot/core",
  "@triagepilot/db",
  "@triagepilot/provider-github",
  "@triagepilot/ui",
] as const;
const licenseId = "FSL-1.1-Apache-2.0";
const publishedAt = "2026-08-28T10:20:30.000Z";
const futureLicenseEffectiveAt = "2028-08-28T10:20:30.000Z";

describe("validateReleaseManifest", () => {
  it("rejects missing or inconsistent FSL licensing metadata", () => {
    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          license: undefined,
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest license must be FSL-1.1-Apache-2.0.");

    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          license: "AGPL-3.0",
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest license must be FSL-1.1-Apache-2.0.");

    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          publishedAt: "not-a-date",
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest publishedAt must be an ISO timestamp.");

    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          futureLicenseEffectiveAt: "not-a-date",
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest futureLicenseEffectiveAt must be an ISO timestamp.");

    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          futureLicenseEffectiveAt: "2028-08-27T10:20:30.000Z",
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest futureLicenseEffectiveAt must be the second anniversary of publishedAt.");
  });

  it("rejects mismatched package versions, commit shas, and migration levels", () => {
    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          packages: createValidManifest().packages.map((entry, index) =>
            index === 0 ? { ...entry, version: "9.9.9" } : entry,
          ),
        },
        validExpectations(),
      ),
    ).toThrow("Package @triagepilot/application version 9.9.9 does not match 0.1.0.");

    expect(() =>
      validateReleaseManifest(createValidManifest(), {
        ...validExpectations(),
        gitCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrow("Release manifest git commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa does not match bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.");

    expect(() =>
      validateReleaseManifest(createValidManifest(), {
        ...validExpectations(),
        databaseMigration: "0005_workspace_scope.sql",
      }),
    ).toThrow("Release manifest database migration 0010_provider_connection_preemptive_revocations.sql does not match 0005_workspace_scope.sql.");
  });

  it("rejects missing digests and mismatched image versions", () => {
    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          container: {
            ...createValidManifest().container,
            digest: "",
          },
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest container digest is missing.");

    expect(() =>
      validateReleaseManifest(
        {
          ...createValidManifest(),
          container: {
            ...createValidManifest().container,
            imageVersion: "9.9.9",
          },
        },
        validExpectations(),
      ),
    ).toThrow("Release manifest image version 9.9.9 does not match 0.1.0.");
  });

  it("accepts a complete 0.1.0 manifest and keeps packages sorted by name", () => {
    const manifest = createValidManifest();

    expect(() => validateReleaseManifest(manifest, validExpectations())).not.toThrow();
    expect(manifest.packages.map((entry) => entry.name)).toEqual([...publishedPackages]);
  });
});

function createValidManifest() {
  return {
    version: "0.1.0",
    gitCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    license: licenseId,
    publishedAt,
    futureLicenseEffectiveAt,
    packages: publishedPackages.map((name, index) => ({
      name,
      version: "0.1.0",
      publishedAt,
      futureLicenseEffectiveAt,
      tarball: `${name.replace("@triagepilot/", "triagepilot-")}-0.1.0.tgz`,
      sha256: `${index + 1}`.repeat(64),
    })),
    contracts: {
      package: "@triagepilot/contracts",
      sha256: "3".repeat(64),
    },
    databaseMigration: {
      id: "0010_provider_connection_preemptive_revocations.sql",
      package: "@triagepilot/db",
    },
    container: {
      digest: `sha256:${"4".repeat(64)}`,
      imageVersion: "0.1.0",
      publishedAt,
      futureLicenseEffectiveAt,
    },
  };
}

function validExpectations() {
  return {
    version: "0.1.0",
    gitCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    databaseMigration: "0010_provider_connection_preemptive_revocations.sql",
    containerDigest: `sha256:${"4".repeat(64)}`,
  };
}
