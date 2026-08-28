import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    remoteContainerDigest?: string;
    remoteManifest?: string;
    tamperedPublishedPackage?: string;
  } = {},
) {
  const calls: Array<{ command: string; args: string[] }> = [];

  return {
    calls,
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
      return { stdout: `${options.remoteContainerDigest ?? fixture.containerDigest}\n` };
    }
    if (command === "oras" && args[0] === "manifest" && args[1] === "fetch") {
      return { stdout: options.remoteManifest ?? fixture.remoteManifest };
    }
    if (command === "oras" && args[0] === "manifest" && args[1] === "fetch-config") {
      return { stdout: fixture.remoteConfig };
    }
    if (command === "oras" && args[0] === "cp") {
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
          annotations: { "org.opencontainers.image.ref.name": version },
        },
      ],
    }),
  );
  await writeFile(join(stageRoot, "blobs", "sha256", configDigest), config);
  await writeFile(join(stageRoot, "blobs", "sha256", manifestDigest), manifest);
  await execFileAsync("tar", ["-cf", path, "-C", stageRoot, "oci-layout", "index.json", "blobs"]);
  return { digest: `sha256:${manifestDigest}`, manifest, config };
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
