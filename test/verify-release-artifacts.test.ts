import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("fails when publishable OCI image manifest annotations disagree with the verified manifest", async () => {
    const fixture = await createArtifactFixture({ imageAnnotationOverrides: { "org.opencontainers.image.licenses": "MIT" } });

    await expect(
      verifyReleaseArtifacts({
        artifactsDir: fixture.artifactsDir,
        version: "0.1.0",
        gitCommit: fixture.gitCommit,
        databaseMigration: "0006_decision_outbox.sql",
        containerDigest: fixture.containerDigest,
      }),
    ).rejects.toThrow("Publishable image annotation org.opencontainers.image.licenses MIT does not match FSL-1.1-Apache-2.0.");
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
    ).rejects.toThrow("Saved image label org.opencontainers.image.licenses MIT does not match FSL-1.1-Apache-2.0 for linux/amd64.");
  });

  it.each([
    {
      name: "traversal path",
      archive: () => createTarBuffer([{ name: "../escape", content: Buffer.from("unsafe\n") }]),
      message: "Unsafe OCI layout archive entry ../escape.",
    },
    {
      name: "symlink",
      archive: () => createTarBuffer([{ name: "safe-symlink", content: Buffer.alloc(0), typeflag: "2", linkname: "/outside" }]),
      message: "Unsupported OCI layout archive entry type 2 at safe-symlink.",
    },
    {
      name: "hardlink",
      archive: () => createTarBuffer([{ name: "safe-hardlink", content: Buffer.alloc(0), typeflag: "1", linkname: "/outside" }]),
      message: "Unsupported OCI layout archive entry type 1 at safe-hardlink.",
    },
    {
      name: "GNU long-name override",
      archive: () => createTarBuffer([{ name: "GNULongName", content: Buffer.from("../escape\0"), typeflag: "L" }]),
      message: "Unsupported OCI layout archive entry type L at GNULongName.",
    },
    {
      name: "PAX path override",
      archive: () => createTarBuffer([{ name: "pax-header", content: Buffer.from("19 path=../escape\n"), typeflag: "x" }]),
      message: "Unsupported OCI layout archive entry type x at pax-header.",
    },
    {
      name: "sub-512-byte archive",
      archive: () => Buffer.alloc(511),
      message: "Malformed OCI layout archive: length is not a multiple of 512 bytes.",
    },
    {
      name: "truncated declared payload",
      archive: () => Buffer.concat([createTarHeader("oci-layout", 1_024), Buffer.alloc(512)]),
      message: "Malformed OCI layout archive: entry oci-layout payload exceeds archive size.",
    },
    {
      name: "missing end marker",
      archive: () => createTarBuffer([{ name: "oci-layout", content: Buffer.from("{}") }], { endBlocks: 0 }),
      message: "Malformed OCI layout archive: missing end-of-archive marker.",
    },
    {
      name: "single zero end block",
      archive: () => createTarBuffer([{ name: "oci-layout", content: Buffer.from("{}") }], { endBlocks: 1 }),
      message: "Malformed OCI layout archive: missing second zero end-of-archive block.",
    },
    {
      name: "nonzero trailing block after end marker",
      archive: () => Buffer.concat([createTarBuffer([{ name: "oci-layout", content: Buffer.from("{}") }]), Buffer.alloc(512, 1)]),
      message: "Malformed OCI layout archive: trailing data after end-of-archive marker.",
    },
    {
      name: "nonzero payload padding",
      archive: () => Buffer.concat([
        createTarHeader("oci-layout", 1),
        Buffer.from("a"),
        Buffer.alloc(510),
        Buffer.from("x"),
        Buffer.alloc(1_024),
      ]),
      message: "Malformed OCI layout archive: entry oci-layout has nonzero padding.",
    },
    {
      name: "partially invalid octal size",
      archive: () => Buffer.concat([
        createTarHeader("oci-layout", 1, undefined, undefined, "0000000001x\0"),
        Buffer.from("a"),
        Buffer.alloc(511),
        Buffer.alloc(1_024),
      ]),
      message: "Invalid OCI layout archive numeric field size at oci-layout.",
    },
  ])("rejects publishable OCI archive with $name before invoking system tar", async ({ archive, message }) => {
    const fixture = await createArtifactFixture();
    await writeFile(fixture.imageTarPath, archive());
    await rewriteChecksum(fixture.artifactsDir, "container/triagepilot-0.1.0.oci.tar");

    await withSystemTarProbe(async (tarProbePath) => {
      await expect(
        verifyReleaseArtifacts({
          artifactsDir: fixture.artifactsDir,
          version: "0.1.0",
          gitCommit: fixture.gitCommit,
          databaseMigration: "0006_decision_outbox.sql",
          containerDigest: fixture.containerDigest,
        }),
      ).rejects.toThrow(message);
      await expect(stat(tarProbePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
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
        .filter((line) => !line.endsWith("container/triagepilot-0.1.0.oci.tar"))
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
    ).rejects.toThrow("checksums.txt is missing container/triagepilot-0.1.0.oci.tar.");
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

async function createArtifactFixture(
  options: { imageLabelOverrides?: Record<string, string>; imageAnnotationOverrides?: Record<string, string> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "triagepilot-release-artifacts-"));
  cleanupPaths.push(root);
  const artifactsDir = join(root, "artifacts");
  const packagesDir = join(artifactsDir, "packages");
  const containerDir = join(artifactsDir, "container");
  await mkdir(packagesDir, { recursive: true });
  await mkdir(containerDir, { recursive: true });

  const gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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

  const imageMetadata = {
    "org.opencontainers.image.version": "0.1.0",
    "org.opencontainers.image.licenses": licenseId,
    "org.opencontainers.image.revision": gitCommit,
    "org.opencontainers.image.created": publishedAt,
    "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
  };
  const imageTarPath = join(containerDir, "triagepilot-0.1.0.oci.tar");
  const containerDigest = await createImageTarball(
    imageTarPath,
    {
      ...imageMetadata,
      ...options.imageLabelOverrides,
    },
    {
      ...imageMetadata,
      ...options.imageAnnotationOverrides,
    },
  );

  const metadataPath = join(containerDir, "metadata.json");
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        "containerimage.digest": containerDigest,
        "containerimage.descriptor": {
          digest: containerDigest,
          annotations: {
            ...imageMetadata,
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

  const checksumLines = [];
  for (const relativePath of [
    "container/metadata.json",
    "container/triagepilot-0.1.0.oci.tar",
    "release-notes.md",
    "release-manifest.json",
    ...packageEntries.map((entry) => `packages/${entry.tarball}`),
  ]) {
    checksumLines.push(`${await sha256(join(artifactsDir, relativePath))}  ${relativePath}`);
  }
  await writeFile(join(artifactsDir, "checksums.txt"), `${checksumLines.join("\n")}\n`);

  return { artifactsDir, gitCommit, containerDigest, imageTarPath };
}

async function rewriteChecksum(artifactsDir: string, relativePath: string) {
  const checksumsPath = join(artifactsDir, "checksums.txt");
  const lines = (await readFile(checksumsPath, "utf8")).trimEnd().split("\n");
  const digest = await sha256(join(artifactsDir, relativePath));
  await writeFile(
    checksumsPath,
    `${lines.map((line) => (line.endsWith(`  ${relativePath}`) ? `${digest}  ${relativePath}` : line)).join("\n")}\n`,
  );
}

async function withSystemTarProbe(callback: (tarProbePath: string) => Promise<void>) {
  const probeRoot = await mkdtemp(join(tmpdir(), "triagepilot-fake-tar-"));
  cleanupPaths.push(probeRoot);
  const tarPath = join(probeRoot, "tar");
  await writeFile(tarPath, '#!/bin/sh\nprintf invoked > "$0.invoked"\nexit 86\n');
  await chmod(tarPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${probeRoot}:${originalPath ?? ""}`;
  try {
    await callback(`${tarPath}.invoked`);
  } finally {
    process.env.PATH = originalPath;
  }
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

async function createImageTarball(
  path: string,
  labels: Record<string, string>,
  annotations: Record<string, string>,
) {
  const stageRoot = await mkdtemp(join(tmpdir(), "triagepilot-image-stage-"));
  cleanupPaths.push(stageRoot);
  const blobs = new Map<string, string>();
  const manifests = ["amd64", "arm64"].map((architecture) => {
    const configContent = JSON.stringify({ architecture, os: "linux", config: { Labels: labels } });
    const configDigest = createHash("sha256").update(configContent).digest("hex");
    blobs.set(configDigest, configContent);
    const manifestContent = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      annotations,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: `sha256:${configDigest}`,
        size: Buffer.byteLength(configContent),
      },
      layers: [],
    });
    const digest = createHash("sha256").update(manifestContent).digest("hex");
    blobs.set(digest, manifestContent);
    return {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${digest}`,
      size: Buffer.byteLength(manifestContent),
      platform: { architecture, os: "linux" },
    };
  });
  const imageIndexContent = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    annotations,
    manifests,
  });
  const imageIndexDigest = createHash("sha256").update(imageIndexContent).digest("hex");
  blobs.set(imageIndexDigest, imageIndexContent);
  await mkdir(join(stageRoot, "blobs", "sha256"), { recursive: true });
  await writeFile(join(stageRoot, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(stageRoot, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.index.v1+json",
          digest: `sha256:${imageIndexDigest}`,
          size: Buffer.byteLength(imageIndexContent),
          annotations: { "org.opencontainers.image.ref.name": "0.1.0" },
        },
      ],
    }),
  );
  for (const [digest, content] of blobs) {
    await writeFile(join(stageRoot, "blobs", "sha256", digest), content);
  }
  await writeFile(path, createTarBuffer(await collectTarEntries(stageRoot)));
  return `sha256:${imageIndexDigest}`;
}

async function collectTarEntries(root: string, relativeDirectory = ""): Promise<Array<{ name: string; content: Buffer }>> {
  const directory = relativeDirectory.length === 0 ? root : join(root, relativeDirectory);
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...(await collectTarEntries(root, relativePath)));
      continue;
    }
    entries.push({ name: relativePath, content: await readFile(join(root, relativePath)) });
  }
  return entries;
}

function createTarBuffer(
  entries: Array<{ name: string; content: Buffer; typeflag?: string; linkname?: string; sizeField?: string }>,
  options: { endBlocks?: number } = {},
) {
  return Buffer.concat([
    ...entries.flatMap((entry) => [
      createTarHeader(entry.name, entry.content.length, entry.typeflag, entry.linkname, entry.sizeField),
      entry.content,
      tarPadding(entry.content.length),
    ]),
    Buffer.alloc((options.endBlocks ?? 2) * 512),
  ]);
}

function createTarHeader(name: string, size: number, typeflag = "0", linkname = "", sizeField?: string) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(sizeField ?? size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write(typeflag, 156, "ascii");
  header.write(linkname, 157, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

function tarPadding(size: number) {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
