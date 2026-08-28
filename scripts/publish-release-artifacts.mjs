#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateOciLayoutArchive } from "./safe-oci-layout-tar.mjs";
import { verifyReleaseArtifacts } from "./verify-release-artifacts.mjs";

const defaultRepoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const imageMetadataKeys = [
  "org.opencontainers.image.version",
  "org.opencontainers.image.licenses",
  "org.opencontainers.image.revision",
  "org.opencontainers.image.created",
  "org.triagepilot.future-license-effective-at",
];

export async function publishReleaseArtifacts(options, command = runCommand) {
  const artifactsDir = resolve(options.artifactsDir ?? join(defaultRepoRoot, "artifacts"));
  const verification = await verifyReleaseArtifacts({
    artifactsDir,
    version: options.version,
    gitCommit: options.gitCommit,
    databaseMigration: options.databaseMigration,
    containerDigest: options.containerDigest,
  });
  const manifest = JSON.parse(await readFile(verification.manifestPath, "utf8"));
  const releaseNotes = await readFile(verification.releaseNotesPath, "utf8");
  const releaseOptions = {
    tagName: options.tagName,
    title: `TriagePilot ${options.version}`,
    releaseNotesPath: verification.releaseNotesPath,
    releaseNotes,
    assets: [
      join(artifactsDir, "release-manifest.json"),
      join(artifactsDir, "checksums.txt"),
    ],
  };
  const releasePlan = await inspectGitHubRelease(releaseOptions, command);
  const container = await ensureContainerImage(
    {
      imageName: options.imageName,
      imageTarPath: verification.imageTarPath,
      version: options.version,
      digest: options.containerDigest,
      expectedValues: expectedImageValues(manifest),
    },
    command,
  );
  const packages = await ensureNpmPackages(artifactsDir, manifest.packages, command);
  const release = await ensureGitHubRelease(releaseOptions, releasePlan, command);

  return { release, container, packages };
}

async function inspectGitHubRelease(options, command) {
  const existing = await command("gh", ["release", "view", options.tagName, "--json", "body,assets"], { allowFailure: true });
  if (existing.exitCode !== 0) {
    return { exists: false, missingAssets: options.assets };
  }

  const parsed = JSON.parse(existing.stdout);
  if (parsed.body !== options.releaseNotes) {
    throw new Error(`GitHub release ${options.tagName} already exists with notes that do not match artifacts/release-notes.md.`);
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error(`GitHub release ${options.tagName} did not return an asset list.`);
  }
  const assetsByName = new Map();
  for (const asset of parsed.assets) {
    if (!asset || typeof asset.name !== "string" || assetsByName.has(asset.name)) {
      throw new Error(`GitHub release ${options.tagName} returned invalid or duplicate asset metadata.`);
    }
    assetsByName.set(asset.name, asset);
  }

  const missingAssets = [];
  for (const path of options.assets) {
    const name = basename(path);
    const remote = assetsByName.get(name);
    if (remote === undefined) {
      missingAssets.push(path);
      continue;
    }
    const expectedDigest = `sha256:${await sha256(path)}`;
    if (remote.digest !== expectedDigest) {
      throw new Error(`GitHub release ${options.tagName} asset ${name} does not match the verified artifact digest.`);
    }
  }
  return { exists: true, missingAssets };
}

async function ensureGitHubRelease(options, plan, command) {
  if (!plan.exists) {
    await command("gh", [
      "release",
      "create",
      options.tagName,
      "--verify-tag",
      "--title",
      options.title,
      "--notes-file",
      options.releaseNotesPath,
    ]);
  }
  for (const asset of plan.missingAssets) {
    await command("gh", ["release", "upload", options.tagName, asset]);
  }
  return plan.exists ? "matched" : "created";
}

async function ensureContainerImage(options, command) {
  const resolved = await command("oras", ["resolve", options.imageName], { allowFailure: true });
  if (resolved.exitCode === 0) {
    const actualDigest = resolved.stdout.trim();
    if (actualDigest !== options.digest) {
      throw new Error(`Published container tag ${options.imageName} digest ${actualDigest} does not match ${options.digest}.`);
    }
    await verifyPublishedImageMetadata(`${options.imageName}@${options.digest}`, options.expectedValues, command);
    return "matched";
  }

  const layoutRoot = await extractOciLayoutArchive(options.imageTarPath);
  try {
    const sourceRef = await readOciLayoutSourceRef(layoutRoot, options.digest);
    await command("oras", ["cp", "--from-oci-layout-path", layoutRoot, sourceRef, options.imageName]);
  } finally {
    await rm(layoutRoot, { recursive: true, force: true });
  }
  const afterPublish = await command("oras", ["resolve", options.imageName]);
  const actualDigest = afterPublish.stdout.trim();
  if (actualDigest !== options.digest) {
    throw new Error(`Published container tag ${options.imageName} digest ${actualDigest} does not match ${options.digest}.`);
  }
  await verifyPublishedImageMetadata(`${options.imageName}@${options.digest}`, options.expectedValues, command);
  return "published";
}

async function verifyPublishedImageMetadata(reference, expectedValues, command) {
  const manifestResult = await command("oras", ["manifest", "fetch", reference]);
  const imageIndex = JSON.parse(manifestResult.stdout);
  const annotations = readRecord(imageIndex.annotations, "published image index annotations");

  for (const key of imageMetadataKeys) {
    if (annotations[key] !== expectedValues[key]) {
      throw new Error(`Published image annotation ${key} ${annotations[key]} does not match ${expectedValues[key]}.`);
    }
  }

  if (!Array.isArray(imageIndex.manifests)) {
    throw new Error("Published OCI image index is missing manifests.");
  }
  const expectedPlatforms = new Set(["linux/amd64", "linux/arm64"]);
  const platformDescriptors = new Map();
  for (const descriptor of imageIndex.manifests) {
    const platform = platformKey(descriptor?.platform);
    if (platform === undefined) continue;
    if (!expectedPlatforms.has(platform)) {
      throw new Error(`Published OCI image index contains unexpected platform ${platform}.`);
    }
    if (platformDescriptors.has(platform)) {
      throw new Error(`Published OCI image index contains duplicate platform ${platform}.`);
    }
    if (typeof descriptor.digest !== "string" || descriptor.digest.length === 0) {
      throw new Error(`Published OCI image index platform ${platform} is missing a manifest digest.`);
    }
    platformDescriptors.set(platform, descriptor);
  }

  const repository = reference.slice(0, reference.lastIndexOf("@"));
  for (const platform of expectedPlatforms) {
    const descriptor = platformDescriptors.get(platform);
    if (descriptor === undefined) {
      throw new Error(`Published OCI image index is missing platform ${platform}.`);
    }
    const configResult = await command("oras", ["manifest", "fetch-config", `${repository}@${descriptor.digest}`]);
    const config = JSON.parse(configResult.stdout);
    const labels = readRecord(config?.config?.Labels, `published image config labels for ${platform}`);
    for (const key of imageMetadataKeys) {
      if (labels[key] !== expectedValues[key]) {
        throw new Error(`Published image label ${key} ${labels[key]} does not match ${expectedValues[key]} for ${platform}.`);
      }
    }
  }
}

function platformKey(platform) {
  const os = platform?.os;
  const architecture = platform?.architecture;
  if (typeof os !== "string" || typeof architecture !== "string" || os === "unknown" || architecture === "unknown") {
    return undefined;
  }
  return `${os}/${architecture}`;
}

async function ensureNpmPackages(artifactsDir, packages, command) {
  const results = [];
  const downloadRoot = await mkdtemp(join(tmpdir(), "triagepilot-published-npm-"));
  try {
    for (const entry of packages) {
      const packageRef = `${entry.name}@${entry.version}`;
      const existing = await command("npm", ["view", packageRef, "dist.tarball", "--json"], { allowFailure: true });
      if (existing.exitCode === 0) {
        const downloaded = await command("npm", ["pack", packageRef, "--pack-destination", downloadRoot]);
        const downloadedTarballName = basename(downloaded.stdout.trim().split("\n").at(-1));
        const downloadedDigest = await sha256(join(downloadRoot, downloadedTarballName));
        if (downloadedDigest !== entry.sha256) {
          throw new Error(`Published npm package ${packageRef} does not match verified artifact digest.`);
        }
        results.push({ name: entry.name, status: "matched" });
        continue;
      }

      await command("npm", ["publish", join(artifactsDir, "packages", basename(entry.tarball)), "--provenance", "--access", "public"]);
      results.push({ name: entry.name, status: "published" });
    }
  } finally {
    await rm(downloadRoot, { recursive: true, force: true });
  }
  return results;
}

async function extractOciLayoutArchive(imageTarPath) {
  await validateOciLayoutArchive(imageTarPath);
  const layoutRoot = await mkdtemp(join(tmpdir(), "triagepilot-oci-layout-"));
  try {
    await execFileAsync("tar", ["-xf", imageTarPath, "-C", layoutRoot], {
      maxBuffer: 16 * 1024 * 1024,
    });
    await readFile(join(layoutRoot, "oci-layout"), "utf8");
    await readFile(join(layoutRoot, "index.json"), "utf8");
    return layoutRoot;
  } catch (error) {
    await rm(layoutRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readOciLayoutSourceRef(layoutRoot, digest) {
  const index = JSON.parse(await readFile(join(layoutRoot, "index.json"), "utf8"));
  const descriptor = index?.manifests?.find((entry) => entry?.digest === digest);
  const sourceRef = descriptor?.annotations?.["org.opencontainers.image.ref.name"];
  if (typeof sourceRef !== "string" || sourceRef.length === 0) {
    throw new Error(`Extracted OCI layout is missing source ref annotation for ${digest}.`);
  }
  return sourceRef;
}

function expectedImageValues(manifest) {
  return {
    "org.opencontainers.image.version": manifest.version,
    "org.opencontainers.image.licenses": manifest.license,
    "org.opencontainers.image.revision": manifest.gitCommit,
    "org.opencontainers.image.created": manifest.publishedAt,
    "org.triagepilot.future-license-effective-at": manifest.futureLicenseEffectiveAt,
  };
}

function readRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (options.allowFailure) {
      return {
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
        stderr: typeof error?.stderr === "string" ? error.stderr : String(error),
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = { artifactsDir: join(defaultRepoRoot, "artifacts") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];
    switch (arg) {
      case "--artifacts-dir":
        args.artifactsDir = nextValue;
        index += 1;
        break;
      case "--version":
        args.version = nextValue;
        index += 1;
        break;
      case "--tag-name":
        args.tagName = nextValue;
        index += 1;
        break;
      case "--image-name":
        args.imageName = nextValue;
        index += 1;
        break;
      case "--git-commit":
        args.gitCommit = nextValue;
        index += 1;
        break;
      case "--database-migration":
        args.databaseMigration = nextValue;
        index += 1;
        break;
      case "--container-digest":
        args.containerDigest = nextValue;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.version || !args.tagName || !args.imageName || !args.gitCommit || !args.databaseMigration || !args.containerDigest) {
    throw new Error("Missing required arguments.");
  }
  return args;
}

async function main() {
  const result = await publishReleaseArtifacts(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
