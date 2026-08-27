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
        expectedDatabaseMigration: "0005_workspace_scope.sql",
        containerDigest: fixture.containerDigest,
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("Expected highest migration 0005_workspace_scope.sql, found 0006_decision_outbox.sql.");
  });

  it("requires exactly the seven unique expected public packages and a contracts artifact", async () => {
    const fixture = await createManifestFixture();

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
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
        ociMetadataPath: fixture.validOciMetadataPath,
        packageTarballs: [...fixture.validTarballs.slice(1), fixture.unexpectedTarball],
      }),
    ).rejects.toThrow("Unexpected published package @triagepilot/unexpected.");
  });

  it("rejects container metadata with digest mismatches or missing version labels", async () => {
    const fixture = await createManifestFixture();

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
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
        ociMetadataPath: fixture.labelMismatchOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata label org.opencontainers.image.version 9.9.9 does not match 0.1.0.");

    await expect(
      createReleaseManifest({
        cwd: fixture.repoRoot,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        containerDigest: fixture.containerDigest,
        ociMetadataPath: fixture.missingLabelOciMetadataPath,
        packageTarballs: fixture.validTarballs,
      }),
    ).rejects.toThrow("OCI metadata is missing org.opencontainers.image.version.");
  });

  it("writes a deterministic manifest with the derived migration and contracts digest", async () => {
    const fixture = await createManifestFixture();

    const first = await createReleaseManifest({
      cwd: fixture.repoRoot,
      version: "0.1.0",
      gitCommit: fixture.gitCommit,
      expectedDatabaseMigration: "0006_decision_outbox.sql",
      containerDigest: fixture.containerDigest,
      ociMetadataPath: fixture.validOciMetadataPath,
      packageTarballs: fixture.validTarballs,
    });
    await rm(join(fixture.repoRoot, "artifacts"), { recursive: true, force: true });
    const second = await createReleaseManifest({
      cwd: fixture.repoRoot,
      version: "0.1.0",
      gitCommit: fixture.gitCommit,
      expectedDatabaseMigration: "0006_decision_outbox.sql",
      containerDigest: fixture.containerDigest,
      ociMetadataPath: fixture.validOciMetadataPath,
      packageTarballs: [...fixture.validTarballs].reverse(),
    });

    expect(first.content).toBe(second.content);

    const manifest = JSON.parse(first.content) as {
      contracts: { sha256: string | null };
      databaseMigration: { id: string };
      packages: Array<{ name: string }>;
    };
    expect(manifest.databaseMigration.id).toBe("0006_decision_outbox.sql");
    expect(manifest.contracts.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.packages.map((entry) => entry.name)).toEqual([...publishedPackages].sort());
    expect(await readFile(first.outputPath, "utf8")).toBe(first.content);
  });
});

async function createManifestFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "triagepilot-release-manifest-"));
  cleanupPaths.push(repoRoot);

  await mkdir(join(repoRoot, "packages", "db", "migrations"), { recursive: true });
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  await writeFile(join(repoRoot, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(repoRoot, "packages", "db", "migrations", "0005_workspace_scope.sql"), "-- 0005\n");
  await writeFile(join(repoRoot, "packages", "db", "migrations", "0006_decision_outbox.sql"), "-- 0006\n");

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
    labels: { "org.opencontainers.image.version": "0.1.0" },
  });
  const digestMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "digest-mismatch.json"), {
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    labels: { "org.opencontainers.image.version": "0.1.0" },
  });
  const labelMismatchOciMetadataPath = await writeOciMetadata(join(ociRoot, "label-mismatch.json"), {
    digest: containerDigest,
    labels: { "org.opencontainers.image.version": "9.9.9" },
  });
  const missingLabelOciMetadataPath = await writeOciMetadata(join(ociRoot, "missing-label.json"), {
    digest: containerDigest,
    labels: {},
  });

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
    JSON.stringify({ name: packageName, version, main: "./dist/index.js", types: "./dist/index.d.ts" }, null, 2),
  );
  await writeFile(join(packageRoot, "LICENSE"), "fixture\n");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
  await writeFile(join(packageRoot, "dist", "index.d.ts"), "export {};\n");
  const tarballPath = join(root, `${slug}-${version}.tgz`);
  await execFileAsync("tar", ["-czf", tarballPath, "-C", stageRoot, "package"]);
  return tarballPath;
}

async function writeOciMetadata(path: string, metadata: { digest: string; labels: Record<string, string> }) {
  await writeFile(path, JSON.stringify(metadata, null, 2));
  return path;
}
