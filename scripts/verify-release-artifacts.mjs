#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readImageReleaseMetadata, validateReleaseManifest } from "./create-release-manifest.mjs";
import { renderReleaseNotes } from "./create-release-notes.mjs";

const defaultRepoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const imageMetadataKeys = [
  "org.opencontainers.image.version",
  "org.opencontainers.image.licenses",
  "org.opencontainers.image.revision",
  "org.opencontainers.image.created",
  "org.triagepilot.future-license-effective-at",
];

export async function verifyReleaseArtifacts(options) {
  const artifactsDir = resolve(options.artifactsDir ?? join(defaultRepoRoot, "artifacts"));
  const manifestPath = join(artifactsDir, "release-manifest.json");
  const releaseNotesPath = join(artifactsDir, "release-notes.md");
  const checksumsPath = join(artifactsDir, "checksums.txt");
  const metadataPath = join(artifactsDir, "container", "metadata.json");
  const imageTarRelativePath = `container/triagepilot-${options.version}.oci.tar`;
  const imageTarPath = join(artifactsDir, imageTarRelativePath);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const metadataDigest = metadata["containerimage.digest"] ?? metadata["containerimage.descriptor"]?.digest;
  if (typeof metadataDigest !== "string" || metadataDigest.length === 0) {
    throw new Error("Buildx metadata did not contain a container digest.");
  }

  validateReleaseManifest(manifest, {
    version: options.version,
    gitCommit: options.gitCommit,
    databaseMigration: options.databaseMigration,
    containerDigest: options.containerDigest,
  });

  if (metadataDigest !== options.containerDigest) {
    throw new Error(`Buildx metadata digest ${metadataDigest} does not match ${options.containerDigest}.`);
  }
  const imageMetadata = await readImageReleaseMetadata(metadataPath, options.containerDigest);
  if (imageMetadata.license !== manifest.license) {
    throw new Error(`Buildx metadata license ${imageMetadata.license} does not match manifest license ${manifest.license}.`);
  }
  if (imageMetadata.revision !== manifest.gitCommit) {
    throw new Error(`Buildx metadata revision ${imageMetadata.revision} does not match manifest git commit ${manifest.gitCommit}.`);
  }
  if (imageMetadata.publishedAt !== manifest.publishedAt) {
    throw new Error(`Buildx metadata publishedAt ${imageMetadata.publishedAt} does not match manifest publishedAt ${manifest.publishedAt}.`);
  }
  if (imageMetadata.futureLicenseEffectiveAt !== manifest.futureLicenseEffectiveAt) {
    throw new Error(
      `Buildx metadata futureLicenseEffectiveAt ${imageMetadata.futureLicenseEffectiveAt} does not match manifest futureLicenseEffectiveAt ${manifest.futureLicenseEffectiveAt}.`,
    );
  }
  const publishableImageMetadata = await readPublishableImageMetadata(imageTarPath, options.containerDigest);
  const expectedImageValues = {
    "org.opencontainers.image.version": manifest.version,
    "org.opencontainers.image.licenses": manifest.license,
    "org.opencontainers.image.revision": manifest.gitCommit,
    "org.opencontainers.image.created": manifest.publishedAt,
    "org.triagepilot.future-license-effective-at": manifest.futureLicenseEffectiveAt,
  };
  for (const key of imageMetadataKeys) {
    if (publishableImageMetadata.annotations[key] !== expectedImageValues[key]) {
      throw new Error(
        `Publishable image annotation ${key} ${publishableImageMetadata.annotations[key]} does not match ${expectedImageValues[key]}.`,
      );
    }
    if (publishableImageMetadata.labels[key] !== expectedImageValues[key]) {
      throw new Error(`Saved image label ${key} ${publishableImageMetadata.labels[key]} does not match ${expectedImageValues[key]}.`);
    }
  }

  const expectedReleaseNotes = renderReleaseNotes(manifest);
  const actualReleaseNotes = await readFile(releaseNotesPath, "utf8");
  if (actualReleaseNotes !== expectedReleaseNotes) {
    throw new Error("release-notes.md does not match the release manifest.");
  }

  const checksumEntries = parseChecksums(await readFile(checksumsPath, "utf8"));
  const expectedRelativePaths = new Set([
    "checksums.txt",
    "release-manifest.json",
    "release-notes.md",
    "container/metadata.json",
    imageTarRelativePath,
    ...manifest.packages.map((entry) => `packages/${basename(entry.tarball)}`),
  ]);
  const expectedChecksummedRelativePaths = new Set([...expectedRelativePaths].filter((path) => path !== "checksums.txt"));
  const expectedPackageRelativePaths = manifest.packages.map((entry) => `packages/${basename(entry.tarball)}`);
  const actualRelativePaths = await collectArtifactFiles(artifactsDir);

  for (const relativePath of expectedChecksummedRelativePaths) {
    if (!checksumEntries.has(relativePath)) {
      throw new Error(`checksums.txt is missing ${relativePath}.`);
    }
  }
  for (const relativePath of checksumEntries.keys()) {
    if (!expectedChecksummedRelativePaths.has(relativePath)) {
      throw new Error(`Unexpected checksum entry ${relativePath}.`);
    }
  }
  for (const relativePath of actualRelativePaths) {
    if (!expectedRelativePaths.has(relativePath)) {
      throw new Error(`Unexpected artifact file ${relativePath}.`);
    }
  }
  for (const relativePath of expectedRelativePaths) {
    if (!actualRelativePaths.has(relativePath)) {
      throw new Error(`Artifact file is missing ${relativePath}.`);
    }
  }

  for (const relativePath of expectedChecksummedRelativePaths) {
    const expectedSha = checksumEntries.get(relativePath);
    const actualSha = await sha256(join(artifactsDir, relativePath));
    if (actualSha !== expectedSha) {
      throw new Error(`Artifact checksum mismatch for ${relativePath}.`);
    }
  }

  for (const relativePath of expectedPackageRelativePaths) {
    const entry = manifest.packages.find((candidate) => `packages/${basename(candidate.tarball)}` === relativePath);
    if (!entry) throw new Error(`Missing manifest package entry for ${relativePath}.`);
    const actualSha = await sha256(join(artifactsDir, relativePath));
    if (actualSha !== entry.sha256) {
      throw new Error(`Artifact checksum mismatch for ${relativePath}.`);
    }
  }

  return { manifestPath, releaseNotesPath, checksumsPath, imageTarPath, packageRelativePaths: expectedPackageRelativePaths };
}

export async function readPublishableImageMetadata(imageTarPath, digest) {
  const { stdout: indexJson } = await execFileAsync("tar", ["-xOf", imageTarPath, "index.json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const index = JSON.parse(indexJson);
  const descriptor = index?.manifests?.find((entry) => entry?.digest === digest);
  if (!descriptor) {
    throw new Error(`Publishable OCI image archive does not describe digest ${digest}.`);
  }

  const { stdout: manifestJson } = await execFileAsync("tar", ["-xOf", imageTarPath, blobPathForDigest(digest)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const manifest = JSON.parse(manifestJson);
  const annotations = readRecord(manifest.annotations, "publishable image annotations");
  const configDigest = manifest?.config?.digest;
  if (typeof configDigest !== "string" || configDigest.length === 0) {
    throw new Error("Publishable OCI image manifest is missing config digest.");
  }

  const { stdout: configJson } = await execFileAsync("tar", ["-xOf", imageTarPath, blobPathForDigest(configDigest)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const config = JSON.parse(configJson);
  const labels = readRecord(config?.config?.Labels, "saved image config labels");
  return { annotations, labels };
}

function blobPathForDigest(digest) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) throw new Error(`Unsupported OCI digest ${digest}.`);
  return `blobs/sha256/${match[1]}`;
}

function readRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value;
}

function parseChecksums(content) {
  const entries = new Map();
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksums.txt line: ${line}`);
    const relativePath = normalizeChecksumPath(match[2]);
    if (entries.has(relativePath)) {
      throw new Error(`Duplicate checksum entry for ${relativePath}.`);
    }
    entries.set(relativePath, match[1]);
  }
  return entries;
}

async function collectArtifactFiles(artifactsDir) {
  const relativePaths = new Set();
  await walkArtifacts(artifactsDir, "", relativePaths);
  return relativePaths;
}

async function walkArtifacts(root, relativeDirectory, relativePaths) {
  const directory = relativeDirectory.length === 0 ? root : join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkArtifacts(root, relativePath, relativePaths);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unexpected artifact type ${relativePath}.`);
    }
    relativePaths.add(relativePath);
  }
}

function normalizeChecksumPath(path) {
  if (isAbsolute(path)) {
    throw new Error(`Checksum entry path must be relative: ${path}`);
  }
  if (path.includes("\\")) {
    throw new Error(`Checksum entry path must use canonical POSIX relative form: ${path}`);
  }
  if (path === "." || path.startsWith("./")) {
    throw new Error(`Checksum entry path must use canonical POSIX relative form: ${path}`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new Error(`Checksum entry path must use canonical POSIX relative form: ${path}`);
  }
  if (path === ".." || path.startsWith("../")) {
    throw new Error(`Checksum entry path escapes artifacts directory: ${path}`);
  }
  if (segments.includes("..")) {
    throw new Error(`Checksum entry path must use canonical POSIX relative form: ${path}`);
  }

  return path;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

  if (!args.version || !args.gitCommit || !args.databaseMigration || !args.containerDigest) {
    throw new Error("Missing required arguments.");
  }

  return args;
}

async function main() {
  const result = await verifyReleaseArtifacts(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    manifestPath: result.manifestPath,
    checksumsPath: result.checksumsPath,
    imageTarPath: result.imageTarPath,
    releaseNotesPath: result.releaseNotesPath,
    packageRelativePaths: result.packageRelativePaths,
  })}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
