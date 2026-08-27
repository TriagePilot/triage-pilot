#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReleaseManifest } from "./create-release-manifest.mjs";

const defaultRepoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function verifyReleaseArtifacts(options) {
  const artifactsDir = resolve(options.artifactsDir ?? join(defaultRepoRoot, "artifacts"));
  const manifestPath = join(artifactsDir, "release-manifest.json");
  const checksumsPath = join(artifactsDir, "checksums.txt");
  const metadataPath = join(artifactsDir, "container", "metadata.json");
  const imageTarRelativePath = `container/triagepilot-${options.version}.tar`;
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

  const checksumEntries = parseChecksums(await readFile(checksumsPath, "utf8"));
  const expectedRelativePaths = new Set([
    "release-manifest.json",
    "container/metadata.json",
    imageTarRelativePath,
    ...manifest.packages.map((entry) => `packages/${basename(entry.tarball)}`),
  ]);

  for (const relativePath of expectedRelativePaths) {
    if (!checksumEntries.has(relativePath)) {
      throw new Error(`checksums.txt is missing ${relativePath}.`);
    }
  }

  for (const relativePath of expectedRelativePaths) {
    const expectedSha = checksumEntries.get(relativePath);
    const actualSha = await sha256(join(artifactsDir, relativePath));
    if (actualSha !== expectedSha) {
      throw new Error(`Artifact checksum mismatch for ${relativePath}.`);
    }
  }

  for (const entry of manifest.packages) {
    const relativePath = `packages/${basename(entry.tarball)}`;
    const actualSha = await sha256(join(artifactsDir, relativePath));
    if (actualSha !== entry.sha256) {
      throw new Error(`Artifact checksum mismatch for ${relativePath}.`);
    }
  }

  return { manifestPath, checksumsPath, imageTarPath };
}

function parseChecksums(content) {
  const entries = new Map();
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksums.txt line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
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
  process.stdout.write(`${result.manifestPath}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
