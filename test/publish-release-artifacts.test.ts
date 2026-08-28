import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    expect(runner.calls.some((call) => call.command === "gh" && call.args[1] === "upload")).toBe(false);
  });

  it("publishes registry artifacts before finalizing a missing release with authoritative attachments", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { releaseExists: false, remoteContainerExists: false });

    await publishReleaseArtifacts(createPublishOptions(fixture), runner.command);

    const commands = runner.calls.map((call) => [call.command, ...call.args].join(" "));
    const releaseCreateIndex = commands.findIndex((command) => command.startsWith(`gh release create ${tagName}`));
    const containerPublishIndex = commands.findIndex((command) => command.startsWith("oras cp "));
    expect(releaseCreateIndex).toBeGreaterThanOrEqual(0);
    expect(containerPublishIndex).toBeGreaterThanOrEqual(0);
    expect(releaseCreateIndex).toBeGreaterThan(containerPublishIndex);
    expect(commands).toContain(`gh release create ${tagName} --verify-tag --title TriagePilot ${version} --notes-file ${join(fixture.artifactsDir, "release-notes.md")}`);
    expect(commands).toContain(`gh release upload ${tagName} ${join(fixture.artifactsDir, "release-manifest.json")}`);
    expect(commands).toContain(`gh release upload ${tagName} ${join(fixture.artifactsDir, "checksums.txt")}`);
  });

  it("resumes an existing release by uploading only its missing authoritative attachment", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { missingReleaseAsset: "checksums.txt" });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).resolves.toMatchObject({
      release: "matched",
    });

    const uploads = runner.calls.filter((call) => call.command === "gh" && call.args[1] === "upload");
    expect(uploads.map((call) => call.args)).toEqual([
      ["release", "upload", tagName, join(fixture.artifactsDir, "checksums.txt")],
    ]);
  });

  it("rejects an existing authoritative attachment whose immutable digest differs", async () => {
    const fixture = await createPublishFixture();
    const runner = createPublishRunner(fixture, { tamperedReleaseAsset: "release-manifest.json" });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      `GitHub release ${tagName} asset release-manifest.json does not match the verified artifact digest.`,
    );
    expect(runner.calls.some((call) => call.command === "oras")).toBe(false);
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

    await expectPublishRejectsBeforeSystemTar(fixture, "Unsafe OCI layout archive entry ../escape.");
  });

  it.each([
    {
      name: "symlink",
      entry: { name: "safe-symlink", content: Buffer.alloc(0), typeflag: "2", linkname: "/outside" },
      message: "Unsupported OCI layout archive entry type 2 at safe-symlink.",
    },
    {
      name: "hardlink",
      entry: { name: "safe-hardlink", content: Buffer.alloc(0), typeflag: "1", linkname: "/outside" },
      message: "Unsupported OCI layout archive entry type 1 at safe-hardlink.",
    },
    {
      name: "GNU long-name override",
      entry: { name: "GNULongName", content: Buffer.from("../escape\0"), typeflag: "L" },
      message: "Unsupported OCI layout archive entry type L at GNULongName.",
    },
    {
      name: "PAX path override",
      entry: { name: "pax-header", content: Buffer.from("19 path=../escape\n"), typeflag: "x" },
      message: "Unsupported OCI layout archive entry type x at pax-header.",
    },
  ])("rejects $name entries before invoking ORAS copy", async ({ entry, message }) => {
    const fixture = await createPublishFixture();
    await rewriteImageArchiveWithEntries(fixture.imageTarPath, [entry]);
    await rewriteChecksum(fixture.artifactsDir, "container/triagepilot-0.1.0.oci.tar");

    await expectPublishRejectsBeforeSystemTar(fixture, message);
  });

  it.each([
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
  ])("rejects malformed OCI archive with $name before invoking system tar", async ({ archive, message }) => {
    const fixture = await createPublishFixture();
    await writeFile(fixture.imageTarPath, archive());
    await rewriteChecksum(fixture.artifactsDir, "container/triagepilot-0.1.0.oci.tar");

    await expectPublishRejectsBeforeSystemTar(fixture, message);
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

  it("rejects an already-published container whose OCI index omits a required architecture", async () => {
    const fixture = await createPublishFixture();
    const remoteManifest = JSON.parse(fixture.remoteManifest) as {
      manifests: Array<{ platform?: { architecture?: string } }>;
    };
    remoteManifest.manifests = remoteManifest.manifests.filter(
      (descriptor) => descriptor.platform?.architecture !== "arm64",
    );
    const runner = createPublishRunner(fixture, { remoteManifest: JSON.stringify(remoteManifest) });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(
      "Published OCI image index is missing platform linux/arm64.",
    );
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
    missingReleaseAsset?: string;
    tamperedReleaseAsset?: string;
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
      const assets = [];
      for (const name of ["release-manifest.json", "checksums.txt"]) {
        if (options.missingReleaseAsset === name) continue;
        assets.push({
          name,
          digest: options.tamperedReleaseAsset === name
            ? `sha256:${"d".repeat(64)}`
            : `sha256:${await sha256(join(fixture.artifactsDir, name))}`,
        });
      }
      return { stdout: JSON.stringify({ body: options.releaseNotes ?? fixture.releaseNotes, assets }) };
    }
    if (command === "gh" && args[0] === "release" && args[1] === "create") {
      return {};
    }
    if (command === "gh" && args[0] === "release" && args[1] === "upload") {
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
      const digest = args[2]?.split("@").at(-1);
      const config = digest === undefined ? undefined : fixture.remoteConfigs.get(digest);
      if (config === undefined) throw new Error(`Unexpected published platform manifest ${args[2]}.`);
      return { stdout: config };
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

async function expectPublishRejectsBeforeSystemTar(fixture: PublishFixture, message: string) {
  await withSystemTarProbe(async (tarProbePath) => {
    const runner = createPublishRunner(fixture, { remoteContainerExists: false });

    await expect(publishReleaseArtifacts(createPublishOptions(fixture), runner.command)).rejects.toThrow(message);
    await expect(stat(tarProbePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.calls.some((call) => call.command === "oras" && call.args[0] === "cp")).toBe(false);
  });
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

type PublishFixture = {
  artifactsDir: string;
  containerDigest: string;
  imageTarPath: string;
  releaseNotes: string;
  remoteManifest: string;
  remoteConfigs: Map<string, string>;
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
    remoteConfigs: image.configs,
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
  const blobs = new Map<string, string>();
  const configs = new Map<string, string>();
  const manifests = ["amd64", "arm64"].map((architecture) => {
    const config = JSON.stringify({ architecture, os: "linux", config: { Labels: labels } });
    const configDigest = createHash("sha256").update(config).digest("hex");
    blobs.set(configDigest, config);
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
    const digest = createHash("sha256").update(manifest).digest("hex");
    blobs.set(digest, manifest);
    configs.set(`sha256:${digest}`, config);
    return {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${digest}`,
      size: Buffer.byteLength(manifest),
      platform: { architecture, os: "linux" },
    };
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    annotations,
    manifests,
  });
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  blobs.set(manifestDigest, manifest);
  await mkdir(join(stageRoot, "blobs", "sha256"), { recursive: true });
  await writeFile(join(stageRoot, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(stageRoot, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.index.v1+json",
          digest: `sha256:${manifestDigest}`,
          size: Buffer.byteLength(manifest),
          annotations: { "org.opencontainers.image.ref.name": imageName },
        },
      ],
    }),
  );
  for (const [digest, content] of blobs) {
    await writeFile(join(stageRoot, "blobs", "sha256", digest), content);
  }
  await writeFile(path, createTarBuffer(await collectTarEntries(stageRoot)));
  return { digest: `sha256:${manifestDigest}`, manifest, configs };
}

async function rewriteImageArchiveWithUnsafeEntry(imageTarPath: string, unsafeEntryName: string) {
  await rewriteImageArchiveWithEntries(imageTarPath, [{ name: unsafeEntryName, content: Buffer.from("unsafe\n") }]);
}

async function rewriteImageArchiveWithEntries(
  imageTarPath: string,
  additionalEntries: Array<{ name: string; content: Buffer; typeflag?: string; linkname?: string }>,
) {
  const extractedRoot = await mkdtemp(join(tmpdir(), "triagepilot-oci-extract-"));
  cleanupPaths.push(extractedRoot);
  await execFileAsync("tar", ["-xf", imageTarPath, "-C", extractedRoot]);
  const entries = await collectTarEntries(extractedRoot);
  entries.push(...additionalEntries);
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

async function collectTarEntries(
  root: string,
  relativeDirectory = "",
): Promise<Array<{ name: string; content: Buffer; typeflag?: string; linkname?: string }>> {
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
