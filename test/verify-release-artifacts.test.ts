import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { verifyReleaseArtifacts } from "../scripts/verify-release-artifacts.mjs";
import { renderReleaseNotes } from "../scripts/create-release-notes.mjs";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const packageNames = [
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

describe("verifyReleaseArtifacts", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("accepts a complete artifact bundle whose tarball digests match the release manifest", async () => {
    const fixture = await createArtifactFixture();

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).resolves.toMatchObject({
      manifestPath: join(fixture.artifactsDir, "release-manifest.json"),
      releaseNotesPath: join(fixture.artifactsDir, "release-notes.md"),
    });
  });

  it("fails when release notes no longer match the verified manifest", async () => {
    const fixture = await createArtifactFixture();
    await writeFile(join(fixture.artifactsDir, "release-notes.md"), "tampered\n");

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("release-notes.md does not match the release manifest.");
  });

  it("fails when saved image config labels disagree with verified OCI annotations", async () => {
    const fixture = await createArtifactFixture({ imageLabelOverrides: { "org.opencontainers.image.licenses": "MIT" } });

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("Saved image label org.opencontainers.image.licenses MIT does not match FSL-1.1-Apache-2.0.");
  });

  it("fails when a package tarball's bytes no longer match the manifest digest", async () => {
    const fixture = await createArtifactFixture();
    const targetTarball = join(fixture.artifactsDir, "packages", "triagepilot-config-0.1.0.tgz");
    await writeFile(targetTarball, "tampered\n");

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("Artifact checksum mismatch for packages/triagepilot-config-0.1.0.tgz.");
  });

  it("fails when checksums.txt is missing the image tar entry", async () => {
    const fixture = await createArtifactFixture();
    const checksumsPath = join(fixture.artifactsDir, "checksums.txt");
    const content = await readFile(checksumsPath, "utf8");
    await writeFile(
      checksumsPath,
      content
        .split("\n")
        .filter((line) => !line.endsWith("container/triagepilot-0.1.0.tar"))
        .join("\n"),
    );

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("checksums.txt is missing container/triagepilot-0.1.0.tar.");
  });

  it("fails when checksums.txt uses absolute paths instead of canonical relative artifact paths", async () => {
    const fixture = await createArtifactFixture();
    const checksumsPath = join(fixture.artifactsDir, "checksums.txt");
    const content = await readFile(checksumsPath, "utf8");
    await writeFile(
      checksumsPath,
      content.replace("release-manifest.json", `${fixture.artifactsDir}/release-manifest.json`),
    );

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("Checksum entry path must be relative: ");
  });

  it("fails when checksums.txt uses non-canonical relative path aliases", async () => {
    const currentDirectoryFixture = await createArtifactFixture();
    await replaceChecksumPath(currentDirectoryFixture.artifactsDir, "release-manifest.json", "./release-manifest.json");
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: currentDirectoryFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: currentDirectoryFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: currentDirectoryFixture.containerDigest,
      }),
    ).rejects.toThrow("Checksum entry path must use canonical POSIX relative form: ./release-manifest.json");

    const internalTraversalFixture = await createArtifactFixture();
    await replaceChecksumPath(
      internalTraversalFixture.artifactsDir,
      "release-manifest.json",
      "container/../release-manifest.json",
    );
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: internalTraversalFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: internalTraversalFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: internalTraversalFixture.containerDigest,
      }),
    ).rejects.toThrow(
      "Checksum entry path must use canonical POSIX relative form: container/../release-manifest.json",
    );

    const repeatedSeparatorFixture = await createArtifactFixture();
    await replaceChecksumPath(repeatedSeparatorFixture.artifactsDir, "container/metadata.json", "container//metadata.json");
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: repeatedSeparatorFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: repeatedSeparatorFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: repeatedSeparatorFixture.containerDigest,
      }),
    ).rejects.toThrow("Checksum entry path must use canonical POSIX relative form: container//metadata.json");

    const backslashFixture = await createArtifactFixture();
    await replaceChecksumPath(backslashFixture.artifactsDir, "container/metadata.json", "container\\metadata.json");
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: backslashFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: backslashFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: backslashFixture.containerDigest,
      }),
    ).rejects.toThrow("Checksum entry path must use canonical POSIX relative form: container\\metadata.json");
  });

  it("fails on duplicate checksum entries, traversal paths, unexpected entries, and extra package tarballs", async () => {
    const duplicateFixture = await createArtifactFixture();
    await writeFile(
      join(duplicateFixture.artifactsDir, "checksums.txt"),
      `${await readFile(join(duplicateFixture.artifactsDir, "checksums.txt"), "utf8")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  release-manifest.json\n`,
    );
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: duplicateFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: duplicateFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: duplicateFixture.containerDigest,
      }),
    ).rejects.toThrow("Duplicate checksum entry for release-manifest.json.");

    const traversalFixture = await createArtifactFixture();
    await writeFile(
      join(traversalFixture.artifactsDir, "checksums.txt"),
      `${await readFile(join(traversalFixture.artifactsDir, "checksums.txt"), "utf8")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ../escape\n`,
    );
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: traversalFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: traversalFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: traversalFixture.containerDigest,
      }),
    ).rejects.toThrow("Checksum entry path escapes artifacts directory: ../escape");

    const unexpectedChecksumFixture = await createArtifactFixture();
    await writeFile(
      join(unexpectedChecksumFixture.artifactsDir, "checksums.txt"),
      `${await readFile(join(unexpectedChecksumFixture.artifactsDir, "checksums.txt"), "utf8")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  packages/unexpected-0.1.0.tgz\n`,
    );
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: unexpectedChecksumFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: unexpectedChecksumFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: unexpectedChecksumFixture.containerDigest,
      }),
    ).rejects.toThrow("Unexpected checksum entry packages/unexpected-0.1.0.tgz.");

    const extraPackageFixture = await createArtifactFixture();
    await writeFile(join(extraPackageFixture.artifactsDir, "packages", "triagepilot-extra-0.1.0.tgz"), "extra\n");
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: extraPackageFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: extraPackageFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: extraPackageFixture.containerDigest,
      }),
    ).rejects.toThrow("Unexpected artifact file packages/triagepilot-extra-0.1.0.tgz.");
  });

  it("fails when required files are missing or unexpected files exist under artifact roots", async () => {
    const missingFixture = await createArtifactFixture();
    await rm(join(missingFixture.artifactsDir, "container", "metadata.json"));
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: missingFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: missingFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: missingFixture.containerDigest,
      }),
    ).rejects.toThrow(/ENOENT/);

    const unexpectedFixture = await createArtifactFixture();
    await writeFile(join(unexpectedFixture.artifactsDir, "container", "extra.txt"), "extra\n");
    await expect(
      verifyReleaseArtifacts({
        artifactsDir: unexpectedFixture.artifactsDir,
        version: "0.1.0",
        gitCommit: unexpectedFixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: unexpectedFixture.containerDigest,
      }),
    ).rejects.toThrow("Unexpected artifact file container/extra.txt.");
  });
});

async function createArtifactFixture(options: { imageLabelOverrides?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "triagepilot-release-artifacts-"));
  cleanupPaths.push(root);
  const artifactsDir = join(root, "artifacts");
  const packagesDir = join(artifactsDir, "packages");
  const containerDir = join(artifactsDir, "container");
  await mkdir(packagesDir, { recursive: true });
  await mkdir(containerDir, { recursive: true });

  const gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const containerDigest = `sha256:${"c".repeat(64)}`;
  const packageEntries = [];
  for (const packageName of packageNames) {
    const tarball = await createPackageTarball(packagesDir, packageName, "0.1.0");
    packageEntries.push({
      name: packageName,
      version: "0.1.0",
      publishedAt,
      futureLicenseEffectiveAt,
      tarball,
      sha256: await sha256(join(packagesDir, tarball)),
    });
  }

  const metadataPath = join(containerDir, "metadata.json");
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        "containerimage.digest": containerDigest,
        "containerimage.descriptor": {
          digest: containerDigest,
          annotations: {
            "org.opencontainers.image.version": "0.1.0",
            "org.opencontainers.image.licenses": licenseId,
            "org.opencontainers.image.revision": gitCommit,
            "org.opencontainers.image.created": publishedAt,
            "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
          },
        },
      },
      null,
      2,
    ),
  );
  const manifest = {
    version: "0.1.0",
    gitCommit,
    license: licenseId,
    publishedAt,
    futureLicenseEffectiveAt,
    packages: packageEntries,
    contracts: {
      package: "@triagepilot/contracts",
      sha256: packageEntries.find((entry) => entry.name === "@triagepilot/contracts")!.sha256,
    },
    databaseMigration: {
      id: "0006_decision_outbox.sql",
      package: "@triagepilot/db",
    },
    container: {
      digest: containerDigest,
      imageVersion: "0.1.0",
      publishedAt,
      futureLicenseEffectiveAt,
    },
  };
  await writeFile(join(artifactsDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(artifactsDir, "release-notes.md"), renderReleaseNotes(manifest));

  const imageTarPath = join(containerDir, "triagepilot-0.1.0.tar");
  await createImageTarball(imageTarPath, {
    "org.opencontainers.image.version": "0.1.0",
    "org.opencontainers.image.licenses": licenseId,
    "org.opencontainers.image.revision": gitCommit,
    "org.opencontainers.image.created": publishedAt,
    "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
    ...options.imageLabelOverrides,
  });

  const checksumLines = [];
  for (const relativePath of [
    "container/metadata.json",
    "container/triagepilot-0.1.0.tar",
    "release-notes.md",
    "release-manifest.json",
    ...packageEntries.map((entry) => `packages/${entry.tarball}`),
  ]) {
    checksumLines.push(`${await sha256(join(artifactsDir, relativePath))}  ${relativePath}`);
  }
  await writeFile(join(artifactsDir, "checksums.txt"), `${checksumLines.join("\n")}\n`);

  return { artifactsDir, gitCommit, containerDigest };
}

async function replaceChecksumPath(artifactsDir: string, from: string, to: string) {
  const checksumsPath = join(artifactsDir, "checksums.txt");
  const content = await readFile(checksumsPath, "utf8");
  await writeFile(checksumsPath, content.replace(from, to));
}

async function createPackageTarball(root: string, packageName: string, version: string) {
  const slug = packageName.replace("@triagepilot/", "triagepilot-");
  const stageRoot = await mkdtemp(join(tmpdir(), `${slug}-stage-`));
  cleanupPaths.push(stageRoot);
  const packageRoot = join(stageRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version, license: licenseId, main: "./dist/index.js", types: "./dist/index.d.ts" }, null, 2),
  );
  await writeFile(join(packageRoot, "LICENSE"), "fixture\n");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
  await writeFile(join(packageRoot, "dist", "index.d.ts"), "export {};\n");
  const tarballPath = join(root, `${slug}-${version}.tgz`);
  await execFileAsync("tar", ["-czf", tarballPath, "-C", stageRoot, "package"]);
  return `${slug}-${version}.tgz`;
}

async function createImageTarball(path: string, labels: Record<string, string>) {
  const stageRoot = await mkdtemp(join(tmpdir(), "triagepilot-image-stage-"));
  cleanupPaths.push(stageRoot);
  const configName = "config.json";
  await writeFile(join(stageRoot, configName), JSON.stringify({ config: { Labels: labels } }, null, 2));
  await writeFile(join(stageRoot, "manifest.json"), JSON.stringify([{ Config: configName, RepoTags: ["triagepilot-release:0.1.0"], Layers: [] }], null, 2));
  await execFileAsync("tar", ["-cf", path, "-C", stageRoot, "manifest.json", configName]);
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
