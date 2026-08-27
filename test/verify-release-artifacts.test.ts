import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { verifyReleaseArtifacts } from "../scripts/verify-release-artifacts.mjs";

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
});

async function createArtifactFixture() {
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
          annotations: { "org.opencontainers.image.version": "0.1.0" },
        },
      },
      null,
      2,
    ),
  );
  const imageTarPath = join(containerDir, "triagepilot-0.1.0.tar");
  await writeFile(imageTarPath, "image-bytes\n");

  const manifest = {
    version: "0.1.0",
    gitCommit,
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
    },
  };
  await writeFile(join(artifactsDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumLines = [];
  for (const relativePath of [
    "container/metadata.json",
    "container/triagepilot-0.1.0.tar",
    "release-manifest.json",
    ...packageEntries.map((entry) => `packages/${entry.tarball}`),
  ]) {
    checksumLines.push(`${await sha256(join(artifactsDir, relativePath))}  ${relativePath}`);
  }
  await writeFile(join(artifactsDir, "checksums.txt"), `${checksumLines.join("\n")}\n`);

  return { artifactsDir, gitCommit, containerDigest };
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
  return `${slug}-${version}.tgz`;
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
