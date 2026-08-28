import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { renderReleaseNotes } from "../scripts/create-release-notes.mjs";
import { publishReleaseArtifacts } from "../scripts/publish-release-artifacts.mjs";

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
const version = "0.1.0";
const tagName = "v0.1.0";
const imageName = "ghcr.io/acme/triagepilot:0.1.0";
const gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const databaseMigration = "0006_decision_outbox.sql";
const publishedAt = "2026-08-28T10:20:30.000Z";
const futureLicenseEffectiveAt = "2028-08-28T10:20:30.000Z";

describe("publishReleaseArtifacts", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("accepts already-published matching release, container, and npm artifacts without republishing", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture);

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).resolves.toMatchObject({
      release: "matched",
      container: "matched",
      packages: packageNames.map((name) => ({ name, status: "matched" })),
    });

    expect(runner.calls.map((call) => [call.command, ...call.args].join(" "))).not.toContain(
      `oras cp --from-oci-layout-path ${fixture.imageTarPath} ${imageName} ${imageName}`,
    );
    expect(runner.calls.some((call) => call.command === "npm" && call.args[0] === "publish")).toBe(false);
    expect(runner.calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false);
  });

  it("creates missing verified release notes before accepting already-published artifacts on retry", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { releaseExists: false });

    await publishReleaseArtifacts(createPublishOptions(fixture), runner.command);

    const commands = runner.calls.map((call) => [call.command, ...call.args].join(" "));
    const releaseCreateIndex = commands.findIndex((command) => command.startsWith(`gh release create ${tagName}`));
    const containerCheckIndex = commands.findIndex((command) => command.startsWith(`oras resolve ${imageName}`));
    expect(releaseCreateIndex).toBeGreaterThanOrEqual(0);
    expect(containerCheckIndex).toBeGreaterThan(releaseCreateIndex);
    expect(commands).toContain(`gh release create ${tagName} --verify-tag --title TriagePilot ${version} --notes-file ${join(fixture.artifactsDir, "release-notes.md")}`);
  });

  it("publishes a missing container from an extracted OCI layout directory and cleans it up", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { remoteContainerExists: false });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).resolves.toMatchObject({
      container: "published",
    });

    const cpCall = runner.calls.find((call) => call.command === "oras" && call.args[0] === "cp");
    expect(cpCall).toBeDefined();
    expect(cpCall!.args[0]).toBe("cp");
    expect(cpCall!.args[1]).toBe("--from-oci-layout-path");
    expect(cpCall!.args[2]).not.toBe(fixture.imageTarPath);
    expect(cpCall!.args[2]).not.toMatch(/\.oci\.tar$/);
    expect(cpCall!.args.slice(3)).toEqual([imageName, imageName]);
    expect(runner.copiedLayoutWasExtracted).toBe(true);
    await expect(stat(cpCall!.args[2])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe OCI archive paths before invoking ORAS copy", async () => {
    const fixture = await createPublishFixture();
    await rewriteImageArchiveWithUnsafeEntry(fixture.imageTarPath, "../escape");
    await rewriteChecksum(fixture.artifactsDir, "container/triagepilot-0.1.0.oci.tar");
    const runner = createPublishRunner(fixture, { remoteContainerExists: false });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      "Unsafe OCI layout archive entry ../escape.",
    );
    expect(runner.calls.some((call) => call.command === "oras" && call.args[0] === "cp")).toBe(false);
  });

  it("cleans the extracted OCI layout when ORAS copy fails", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { remoteContainerExists: false, failContainerCopy: true });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow("copy failed");

    const cpCall = runner.calls.find((call) => call.command === "oras" && call.args[0] === "cp");
    expect(cpCall).toBeDefined();
    await expect(stat(cpCall!.args[2])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects already-published artifacts when the immutable remote container digest differs", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { remoteContainerDigest: `sha256:${"d".repeat(64)}` });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      `Published container tag ${imageName} digest sha256:${"d".repeat(64)} does not match ${fixture.containerDigest}.`,
    );
    expect(runner.calls.some((call) => call.command === "npm" && call.args[0] === "publish")).toBe(false);
  });

  it("rejects already-published containers when digest-bound remote annotations differ", async () => {
    const fixture = await createPublishFixture();
    const remoteManifest = JSON.parse(fixture.remoteManifest) as { annotations: Record<string, string> };
    remoteManifest.annotations["org.opencontainers.image.licenses"] = "MIT";
    const runner = createPublishRunner(fixture, { remoteManifest: JSON.stringify(remoteManifest) });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      "Published image annotation org.opencontainers.image.licenses MIT does not match FSL-1.1-Apache-2.0.",
    );
    expect(runner.calls.some((call) => call.command === "npm" && call.args[0] === "publish")).toBe(false);
  });

  it("rejects already-published npm packages when downloaded package bytes differ", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { tamperedPublishedPackage: "@triagepilot/config" });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      "Published npm package @triagepilot/config@0.1.0 does not match verified artifact digest.",
    );
  });

  it("rejects an existing GitHub release whose notes differ from the verified release notes", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { releaseNotes: "tampered\n" });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      `GitHub release ${tagName} already exists with notes that do not match artifacts/release-notes.md.`,
    );
    expect(runner.calls.some((call) => call.command === "oras")).toBe(false);
  });
});

function createPublishOptions(fixture: PublishFixture) {
  return {
    artifactsDir: fixture.artifactsDir,
    version,
    tagName,
    imageName,
    gitCommit,
    databaseMigration,
    containerDigest: fixture.containerDigest,
  };
}

function createPublishRunner(
  fixture: PublishFixture,
  options: {
    releaseExists?: boolean;
    releaseNotes?: string;
    remoteContainerExists?: boolean;
    remoteContainerDigest?: string;
    remoteManifest?: string;
    failContainerCopy?: boolean;
    tamperedPublishedPackage?: string;
  } = {},
) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let resolveCalls = 0;
  let copiedLayoutWasExtracted = false;

  return {
    calls,
    get copiedLayoutWasExtracted() {
      return copiedLayoutWasExtracted;
    },
    async command(command: string, args: string[], commandOptions: { allowFailure?: boolean; cwd?: string } = {}) {
      calls.push({ command, args });
      const result = await handleCommand(command, args, commandOptions);
      if ((result.exitCode ?? 0) !== 0 && !commandOptions.allowFailure) {
        throw new Error(result.stderr || `${command} failed`);
      }
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
    },
  };

  async function handleCommand(command: string, args: string[], commandOptions: { cwd?: string }) {
    if (command === "gh" && args[0] === "release" && args[1] === "view") {
      if (options.releaseExists === false) return { exitCode: 1, stderr: "not found" };
      return { stdout: JSON.stringify({ body: options.releaseNotes ?? fixture.releaseNotes }) };
    }
    if (command === "gh" && args[0] === "release" && args[1] === "create") {
      return {};
    }
    if (command === "oras" && args[0] === "resolve") {
      resolveCalls += 1;
      if (options.remoteContainerExists === false && resolveCalls === 1) {
        return { exitCode: 1, stderr: "not found" };
      }
      return { stdout: `${options.remoteContainerDigest ?? fixture.containerDigest}\n` };
    }
    if (command === "oras" && args[0] === "manifest" && args[1] === "fetch") {
      return { stdout: options.remoteManifest ?? fixture.remoteManifest };
    }
    if (command === "oras" && args[0] === "manifest" && args[1] === "fetch-config") {
      return { stdout: fixture.remoteConfig };
    }
    if (command === "oras" && args[0] === "cp") {
      expect(args[1]).toBe("--from-oci-layout-path");
      expect(args[2]).not.toBe(fixture.imageTarPath);
      expect(await readFile(join(args[2], "oci-layout"), "utf8")).toContain("imageLayoutVersion");
      expect(await readFile(join(args[2], "index.json"), "utf8")).toContain(fixture.containerDigest);
      copiedLayoutWasExtracted = true;
      if (options.failContainerCopy) return { exitCode: 1, stderr: "copy failed" };
      return {};
    }
    if (command === "npm" && args[0] === "view") {
      return { stdout: "\"https://registry.npmjs.test/package.tgz\"\n" };
    }
    if (command === "npm" && args[0] === "pack") {
      const packageRef = args[1];
      const packageName = packageRef.replace(/@0\.1\.0$/, "");
      const packDestination = args[args.indexOf("--pack-destination") + 1] ?? commandOptions.cwd;
      if (!packDestination) throw new Error("missing pack destination");
      const tarball = fixture.packageTarballs.get(packageName);
      if (!tarball) throw new Error(`unexpected package ${packageName}`);
      const outputName = basename(tarball);
      await writeFile(
        join(packDestination, outputName),
        options.tamperedPublishedPackage === packageName ? "tampered\n" : await readFile(tarball),
      );
      return { stdout: `${outputName}\n` };
    }
    if (command === "npm" && args[0] === "publish") {
      return {};
    }
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  }
}

type PublishFixture = {
  artifactsDir: string;
  containerDigest: string;
  imageTarPath: string;
  releaseNotes: string;
  remoteManifest: string;
  remoteConfig: string;
  packageTarballs: Map<string, string>;
};

async function createPublishFixture(): Promise<PublishFixture> {
  const root = await mkdtemp(join(tmpdir(), "triagepilot-publish-artifacts-"));
  cleanupPaths.push(root);
  const artifactsDir = join(root, "artifacts");
  const packagesDir = join(artifactsDir, "packages");
  const containerDir = join(artifactsDir, "container");
  await mkdir(packagesDir, { recursive: true });
  await mkdir(containerDir, { recursive: true });

  const packageEntries = [];
  const packageTarballs = new Map<string, string>();
  for (const packageName of packageNames) {
    const tarball = await createPackageTarball(packagesDir, packageName);
    packageTarballs.set(packageName, join(packagesDir, tarball));
    packageEntries.push({
      name: packageName,
      version,
      publishedAt,
      futureLicenseEffectiveAt,
      tarball,
      sha256: await sha256(join(packagesDir, tarball)),
    });
  }

  const imageMetadata = {
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.licenses": licenseId,
    "org.opencontainers.image.revision": gitCommit,
    "org.opencontainers.image.created": publishedAt,
    "org.triagepilot.future-license-effective-at": futureLicenseEffectiveAt,
  };
  const imageTarPath = join(containerDir, "triagepilot-0.1.0.oci.tar");
  const image = await createImageTarball(imageTarPath, imageMetadata, imageMetadata);

  await writeFile(
    join(containerDir, "metadata.json"),
    JSON.stringify(
      {
        "containerimage.digest": image.digest,
        "containerimage.descriptor": {
          digest: image.digest,
          annotations: imageMetadata,
        },
      },
      null,
      2,
    ),
  );

  const manifest = {
    version,
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
      id: databaseMigration,
      package: "@triagepilot/db",
    },
    container: {
      digest: image.digest,
      imageVersion: version,
      publishedAt,
      futureLicenseEffectiveAt,
    },
  };
  await writeFile(join(artifactsDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const releaseNotes = renderReleaseNotes(manifest);
  await writeFile(join(artifactsDir, "release-notes.md"), releaseNotes);

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

  return {
    artifactsDir,
    containerDigest: image.digest,
    imageTarPath,
    releaseNotes,
    remoteManifest: image.manifest,
    remoteConfig: image.config,
    packageTarballs,
  };
}

async function createPackageTarball(root: string, packageName: string) {
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
  const config = JSON.stringify({ config: { Labels: labels } });
  const configDigest = createHash("sha256").update(config).digest("hex");
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    annotations,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${configDigest}`,
      size: Buffer.byteLength(config),
    },
    layers: [],
  });
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  await mkdir(join(stageRoot, "blobs", "sha256"), { recursive: true });
  await writeFile(join(stageRoot, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(stageRoot, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${manifestDigest}`,
          size: Buffer.byteLength(manifest),
          annotations: { "org.opencontainers.image.ref.name": imageName },
        },
      ],
    }),
  );
  await writeFile(join(stageRoot, "blobs", "sha256", configDigest), config);
  await writeFile(join(stageRoot, "blobs", "sha256", manifestDigest), manifest);
  await execFileAsync("tar", ["-cf", path, "-C", stageRoot, "oci-layout", "index.json", "blobs"]);
  return { digest: `sha256:${manifestDigest}`, manifest, config };
}

async function rewriteImageArchiveWithUnsafeEntry(imageTarPath: string, unsafeEntryName: string) {
  const extractedRoot = await mkdtemp(join(tmpdir(), "triagepilot-oci-extract-"));
  cleanupPaths.push(extractedRoot);
  await execFileAsync("tar", ["-xf", imageTarPath, "-C", extractedRoot]);
  const entries = await collectTarEntries(extractedRoot);
  entries.push({ name: unsafeEntryName, content: Buffer.from("unsafe\n") });
  await writeFile(imageTarPath, createTarBuffer(entries));
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

function createTarBuffer(entries: Array<{ name: string; content: Buffer }>) {
  return Buffer.concat([...entries.flatMap((entry) => [createTarHeader(entry.name, entry.content.length), entry.content, tarPadding(entry.content.length)]), Buffer.alloc(1024)]);
}

function createTarHeader(name: string, size: number) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, "ascii");
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
