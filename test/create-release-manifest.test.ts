import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { createReleaseManifest } from "../scripts/create-release-manifest.mjs";

const execFileAsync = promisify(execFile);

const publishedPackages = [
  "@triagepilot/contracts",
  "@triagepilot/config",
  "@triagepilot/core",
  "@triagepilot/application",
  "@triagepilot/db",
  "@triagepilot/provider-github",
  "@triagepilot/ui",
] as const;
const licenseId = "FSL-1.1-Apache-2.0";
const publishedAt = "2026-08-28T10:20:30.000Z";
const futureLicenseEffectiveAt = "2028-08-28T10:20:30.000Z";
const currentDatabaseMigration = "0010_provider_connection_preemptive_revocations.sql";
const migrationFiles = [
  "0001_initial.sql",
  "0002_selected_reviewers.sql",
  "0003_human_review_policy.sql",
  "0004_semantic_routing_deduplication.sql",
  "0005_reviewer_availability.sql",
  "0005_workspace_scope.sql",
  "0006_decision_outbox.sql",
  "0007_workspace_reviewer_availability.sql",
  "0008_reviewer_mutation_intents.sql",
  "0009_provider_connection_revocations.sql",
  currentDatabaseMigration,
] as const;

const cleanupPaths: string[] = [];

describe("createReleaseManifest", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("derives the highest migration and rejects a stale expected migration", async () => {
    const fixture = await createManifestFixture();

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        expectedDatabaseMigration: "0009_provider_connection_revocations.sql",
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow(`Expected highest migration 0009_provider_connection_revocations.sql, found ${currentDatabaseMigration}.`);
  });

  it("requires both historical 0005 migration lineages", async () => {
    const missingReviewerAvailability = await createManifestFixture({
      omitMigration: "0005_reviewer_availability.sql",
    });

    await expect(
      createReleaseManifest({
        cwd: missingReviewerAvailability.repoRoot,
        version: "0.1.0",
        gitCommit: missingReviewerAvailability.gitCommit,
        expectedDatabaseMigration: currentDatabaseMigration,
        containerDigest: missingReviewerAvailability.containerDigest,
        publishedAt,
        ociMetadataPath: missingReviewerAvailability.validOciMetadataPath,
        packageTarballs: missingReviewerAvailability.validTarballs,
      }),
    ).rejects.toThrow("Missing required historical database migration 0005_reviewer_availability.sql.");

    const missingWorkspaceScope = await createManifestFixture({
      omitMigration: "0005_workspace_scope.sql",
    });

    await expect(
      createReleaseManifest({
        cwd: missingWorkspaceScope.repoRoot,
        version: "0.1.0",
        gitCommit: missingWorkspaceScope.gitCommit,
        expectedDatabaseMigration: currentDatabaseMigration,
        containerDigest: missingWorkspaceScope.containerDigest,
        publishedAt,
        ociMetadataPath: missingWorkspaceScope.validOciMetadataPath,
        packageTarballs: missingWorkspaceScope.validTarballs,
      }),
    ).rejects.toThrow("Missing required historical database migration 0005_workspace_scope.sql.");
  });

  it("requires exactly the seven unique expected public packages and a contracts artifact", async () => {
    const fixture = await createManifestFixture();

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: fixture.validTarballs.filter((path) => !path.includes("contracts")),
      }),
    ).rejects.toThrow("Missing required package tarballs: @triagepilot/contracts.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: [...fixture.validTarballs, fixture.validTarballs[0]],
      }),
    ).rejects.toThrow("Duplicate package tarball for @triagepilot/contracts.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: [...fixture.validTarballs.slice(1), fixture.unexpectedTarball],
      }),
    ).rejects.toThrow("Unexpected published package @triagepilot/unexpected.");
  });

  it("rejects container metadata with digest mismatches or missing release annotations", async () => {
    const fixture = await createManifestFixture();

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.digestMismatchOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow(`OCI metadata does not describe digest ${fixture.containerDigest}.`);

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.labelMismatchOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata annotation org.opencontainers.image.version 9.9.9 does not match 0.1.0.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.missingLabelOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata is missing annotation org.opencontainers.image.version.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.licenseMismatchOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata annotation org.opencontainers.image.licenses MIT does not match FSL-1.1-Apache-2.0.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.publishedAtMismatchOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata annotation org.opencontainers.image.created 2026-08-27T10:20:30.000Z does not match 2026-08-28T10:20:30.000Z.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.labelsOnlyOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata is missing annotation org.opencontainers.image.version.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        publishedAt,
        ociMetadataPath: fixture.conflictingAnnotationsOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata annotation org.opencontainers.image.version has conflicting values.");
  });

  it("accepts Buildx metadata files with descriptor annotations", async () => {
    const fixture = await createManifestFixture();

    const result = await createReleaseManifest({
      cwd: fixture.repoRoot,
      version: "0.1.0",
      gitCommit: fixture.gitCommit,
      expectedDatabaseMigration: currentDatabaseMigration,
      containerDigest: fixture.containerDigest,
      publishedAt,
      ociMetadataPath: fixture.buildxOciMetadataPath,
      packageTarballs: fixture.validTarballs,
    });

    expect(result.content).toContain(fixture.containerDigest);
    expect(result.content).toContain('"imageVersion": "0.1.0"');
    expect(result.content).toContain(`"license": "${licenseId}"`);
    expect(result.content).toContain(`"publishedAt": "${publishedAt}"`);
    expect(result.content).toContain(`"futureLicenseEffectiveAt": "${futureLicenseEffectiveAt}"`);
  });

  it("writes a deterministic manifest with the derived migration and contracts digest", async () => {
    const fixture = await createManifestFixture();

    const first = await createReleaseManifest({
      cwd: fixture.repoRoot,
      version: "0.1.0",
      gitCommit: fixture.gitCommit,
      expectedDatabaseMigration: currentDatabaseMigration,
      containerDigest: fixture.containerDigest,
      publishedAt,
      ociMetadataPath: fixture.validOciMetadataPath,
      packageTarballs: fixture.validTarballs,
    });
    await rm(join(fixture.repoRoot, "artifacts"), { recursive: true, force: true });
    const second = await createReleaseManifest({
      cwd: fixture.repoRoot,
      version: "0.1.0",
      gitCommit: fixture.gitCommit,
      expectedDatabaseMigration: currentDatabaseMigration,
      containerDigest: fixture.containerDigest,
      publishedAt,
      ociMetadataPath: fixture.validOciMetadataPath,
      packageTarballs: [...fixture.validTarballs].reverse(),
    });

    expect(first.content).toBe(second.content);

    const manifest = JSON.parse(first.content) as {
      contracts: { sha256: string | null };
      databaseMigration: { id: string };
      packages: Array<{ name: string; publishedAt: string; futureLicenseEffectiveAt: string }>;
    };
    expect(manifest.databaseMigration.id).toBe(currentDatabaseMigration);
    expect(manifest.contracts.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.packages.map((entry) => entry.name)).toEqual([...publishedPackages].sort());
    expect(manifest.packages.map((entry) => entry.publishedAt)).toEqual(publishedPackages.map(() => publishedAt));
    expect(manifest.packages.map((entry) => entry.futureLicenseEffectiveAt)).toEqual(
      publishedPackages.map(() => futureLicenseEffectiveAt),
    );
    expect(await readFile(first.outputPath, "utf8")).toBe(first.content);
  });
});

async function createManifestFixture(options: { omitMigration?: string } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), "triagepilot-release-manifest-"));
  cleanupPaths.push(repoRoot);

  await mkdir(join(repoRoot, "packages", "db", "migrations"), { recursive: true });
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  await writeFile(join(repoRoot, "Dockerfile"), "FROM scratch\n");
  for (const migration of migrationFiles) {
    if (migration !== options.omitMigration) {
      await writeFile(join(repoRoot, "packages", "db", "migrations", migration), `-- ${migration}\n`);
    }
  }

  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Codex"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repoRoot });
  const gitCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();

  const packageTarballRoot = await mkdtemp(join(tmpdir(), "triagepilot-release-tarballs-"));
  cleanupPaths.push(packageTarballRoot);
  const validTarballs: string[] = [];
  for (const packageName of publishedPackages) {
    validTarballs.push(await createPackageTarball(packageTarballRoot, packageName, "0.1.0"));
  }
  const unexpectedTarball = await createPackageTarball(packageTarballRoot, "@triagepilot/unexpected", "0.1.0");

  const ociRoot = await mkdtemp(join(tmpdir(), "triagepilot-release-oci-"));
  cleanupPaths.push(ociRoot);
  const containerDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const validOciMetadataPath = await writeOciMetadata(join(ociRoot, "valid.json"), {
    digest: containerDigest,
    gitCommit,
    labels: { "org.opencontainers.image.version": "0.1.0" },
  });
  const digestMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "digest-mismatch.json"), {
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    gitCommit,
    labels: { "org.opencontainers.image.version": "0.1.0" },
  });
  const labelMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "label-mismatch.json"), {
    digest: containerDigest,
    gitCommit,
    labels: {},
    annotations: createOciAnnotations(gitCommit, { "org.opencontainers.image.version": "9.9.9" }),
  });
  const missingLabelOciMetadataPath = await writeOciMetadata(join(ociRoot, "missing-label.json"), {
    digest: containerDigest,
    gitCommit,
    labels: {},
    annotations: createOciAnnotations(gitCommit, { "org.opencontainers.image.version": undefined }),
  });
  const labelsOnlyOciMetadataPath = await writeOciMetadata(join(ociRoot, "labels-only.json"), {
    digest: containerDigest,
    gitCommit,
    labels: { "org.opencontainers.image.version": "0.1.0" },
    annotations: {},
  });
  const licenseMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "license-mismatch.json"), {
    digest: containerDigest,
    gitCommit,
    labels: {},
    annotations: createOciAnnotations(gitCommit, { "org.opencontainers.image.licenses": "MIT" }),
  });
  const publishedAtMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "published-at-mismatch.json"), {
    digest: containerDigest,
    gitCommit,
    labels: {},
    annotations: createOciAnnotations(gitCommit, { "org.opencontainers.image.created": "2026-08-27T10:20:30.000Z" }),
  });
  const buildxOciMetadataPath = join(ociRoot, "buildx.json");
  await writeFile(
    buildxOciMetadataPath,
    JSON.stringify(
      {
        "buildx.build.provenance": {},
        "containerimage.descriptor": {
          annotations: {
            "org.opencontainers.image.version": "0.1.0",
            "org.opencontainers.image.licenses": licenseId,
            "org.opencontainers.image.revision": gitCommit,
            "org.opencontainers.image.created": publishedAt,
            "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
          },
          digest: containerDigest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          size: 506,
        },
        "containerimage.digest": containerDigest,
      },
      null,
      2,
    ),
  );
  const conflictingAnnotationsOciMetadataPath = join(ociRoot, "conflicting-annotations.json");
  await writeFile(
    conflictingAnnotationsOciMetadataPath,
    JSON.stringify(
      {
        annotations: createOciAnnotations(gitCommit),
        "containerimage.descriptor": {
          annotations: createOciAnnotations(gitCommit, { "org.opencontainers.image.version": "9.9.9" }),
          digest: containerDigest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          size: 506,
        },
        "containerimage.digest": containerDigest,
      },
      null,
      2,
    ),
  );

  return {
    repoRoot,
    gitCommit,
    containerDigest,
    validTarballs,
    unexpectedTarball,
    validOciMetadataPath,
    digestMismatchOciMetadataPath,
    labelMismatchOciMetadataPath,
    missingLabelOciMetadataPath,
    labelsOnlyOciMetadataPath,
    licenseMismatchOciMetadataPath,
    publishedAtMismatchOciMetadataPath,
    buildxOciMetadataPath,
    conflictingAnnotationsOciMetadataPath,
  };
}

async function createPackageTarball(root: string, packageName: string, version: string) {
  const slug = packageName.replace("@triagepilot/", "triagepilot-");
  const stageRoot = await mkdtemp(join(tmpdir(), `${slug}-stage-`));
  cleanupPaths.push(stageRoot);
  const packageRoot = join(stageRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version,
        license: licenseId,
        publishedAt,
        futureLicenseEffectiveAt,
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      null,
      2,
    ),
  );
  await writeFile(join(packageRoot, "LICENSE"), "fixture\n");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
  await writeFile(join(packageRoot, "dist", "index.d.ts"), "export {};\n");
  const tarballPath = join(root, `${slug}-${version}.tgz`);
  await execFileAsync("tar", ["-czf", tarballPath, "-C", stageRoot, "package"]);
  return tarballPath;
}

async function writeOciMetadata(
  path: string,
  metadata: { digest: string; gitCommit?: string; labels: Record<string, string>; annotations?: Record<string, string> },
) {
  const annotations = metadata.annotations ?? createOciAnnotations(metadata.gitCommit ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await writeFile(
    path,
    JSON.stringify(
      {
        digest: metadata.digest,
        labels: {
          ...metadata.labels,
        },
        annotations,
      },
      null,
      2,
    ),
  );
  return path;
}

function createOciAnnotations(gitCommit: string, overrides: Record<string, string | undefined> = {}) {
  const annotations: Record<string, string> = {
    "org.opencontainers.image.licenses": licenseId,
    "org.opencontainers.image.revision": gitCommit,
    "org.opencontainers.image.created": publishedAt,
    "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
    "org.opencontainers.image.version": "0.1.0",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete annotations[key];
      continue;
    }
    annotations[key] = value;
  }
  return annotations;
}
