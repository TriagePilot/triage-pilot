#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultRepoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publishedPackages = [
  "@triagepilot/contracts",
  "@triagepilot/config",
  "@triagepilot/core",
  "@triagepilot/application",
  "@triagepilot/db",
  "@triagepilot/provider-github",
  "@triagepilot/ui",
];

export async function createReleaseManifest(options) {
  const repoRoot = resolve(options.cwd ?? defaultRepoRoot);
  await assertCleanCheckout(repoRoot, options.gitCommit);

  const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (rootManifest.version !== options.version) {
    throw new Error(`Root package version ${rootManifest.version} does not match ${options.version}.`);
  }

  const highestMigration = await findHighestDatabaseMigration(repoRoot);
  if (options.expectedDatabaseMigration && options.expectedDatabaseMigration !== highestMigration) {
    throw new Error(`Expected highest migration ${options.expectedDatabaseMigration}, found ${highestMigration}.`);
  }

  const packages = [];
  const seenPackages = new Set();
  for (const tarballPath of options.packageTarballs) {
    const absoluteTarballPath = resolve(repoRoot, tarballPath);
    const manifest = JSON.parse(
      (await execFileAsync("tar", ["-xOf", absoluteTarballPath, "package/package.json"], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
      })).stdout,
    );
    if (!publishedPackages.includes(manifest.name)) {
      throw new Error(`Unexpected published package ${manifest.name}.`);
    }
    if (seenPackages.has(manifest.name)) {
      throw new Error(`Duplicate package tarball for ${manifest.name}.`);
    }
    if (manifest.version !== options.version) {
      throw new Error(`Package ${manifest.name} version ${manifest.version} does not match ${options.version}.`);
    }
    seenPackages.add(manifest.name);

    packages.push({
      name: manifest.name,
      version: manifest.version,
      tarball: basename(absoluteTarballPath),
      sha256: createHash("sha256").update(await readFile(absoluteTarballPath)).digest("hex"),
    });
  }

  const missingPackages = publishedPackages.filter((packageName) => !seenPackages.has(packageName));
  if (missingPackages.length > 0) {
    throw new Error(`Missing required package tarballs: ${missingPackages.join(", ")}.`);
  }

  const imageVersion = await readImageVersionFromOciMetadata(options.ociMetadataPath, options.containerDigest);
  if (imageVersion !== options.version) {
    throw new Error(`OCI metadata label org.opencontainers.image.version ${imageVersion} does not match ${options.version}.`);
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));
  const contractsPackage = packages.find((entry) => entry.name === "@triagepilot/contracts");
  if (!contractsPackage) throw new Error("Missing required contracts artifact.");

  const manifest = {
    version: options.version,
    gitCommit: options.gitCommit,
    packages,
    contracts: {
      package: "@triagepilot/contracts",
      sha256: contractsPackage.sha256,
    },
    databaseMigration: {
      id: highestMigration,
      package: "@triagepilot/db",
    },
    container: {
      digest: options.containerDigest,
      imageVersion,
    },
  };

  const outputPath = join(repoRoot, "artifacts", "release-manifest.json");
  await mkdir(join(repoRoot, "artifacts"), { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outputPath, content);
  return { outputPath, content };
}

export async function findHighestDatabaseMigration(repoRoot) {
  const migrationDir = join(repoRoot, "packages", "db", "migrations");
  const migrations = (await readdir(migrationDir))
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .sort();
  const highestMigration = migrations.at(-1);
  if (!highestMigration) throw new Error("No database migrations found.");
  return highestMigration;
}

async function assertCleanCheckout(repoRoot, expectedCommit) {
  const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const actualCommit = headSha.trim();
  if (actualCommit !== expectedCommit) throw new Error(`Expected git commit ${expectedCommit}, got ${actualCommit}.`);

  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.trim().length > 0) throw new Error("Checkout is dirty.");
}

export async function readImageVersionFromOciMetadata(ociMetadataPath, digest) {
  const metadata = JSON.parse(await readFile(ociMetadataPath, "utf8"));
  const candidates = Array.isArray(metadata) ? metadata : [metadata];
  const match = candidates.find((candidate) => metadataMatchesDigest(candidate, digest));
  if (!match) {
    throw new Error(`OCI metadata does not describe digest ${digest}.`);
  }

  const labels = readLabels(match);
  const version = labels["org.opencontainers.image.version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("OCI metadata is missing org.opencontainers.image.version.");
  }
  return version;
}

function metadataMatchesDigest(candidate, digest) {
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.digest === digest) return true;
  const repoDigests = [
    ...(Array.isArray(candidate.repoDigests) ? candidate.repoDigests : []),
    ...(Array.isArray(candidate.RepoDigests) ? candidate.RepoDigests : []),
  ];
  return repoDigests.some((entry) => typeof entry === "string" && entry.endsWith(`@${digest}`));
}

function readLabels(candidate) {
  if (!candidate || typeof candidate !== "object") return {};
  if (candidate.labels && typeof candidate.labels === "object" && !Array.isArray(candidate.labels)) {
    return candidate.labels;
  }
  if (
    candidate.Config &&
    typeof candidate.Config === "object" &&
    candidate.Config.Labels &&
    typeof candidate.Config.Labels === "object" &&
    !Array.isArray(candidate.Config.Labels)
  ) {
    return candidate.Config.Labels;
  }
  return {};
}

function parseArgs(argv) {
  const args = {
    packageTarballs: [],
    cwd: defaultRepoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];

    switch (arg) {
      case "--version":
        args.version = nextValue;
        index += 1;
        break;
      case "--git-commit":
        args.gitCommit = nextValue;
        index += 1;
        break;
      case "--database-migration":
        args.expectedDatabaseMigration = nextValue;
        index += 1;
        break;
      case "--container-digest":
        args.containerDigest = nextValue;
        index += 1;
        break;
      case "--oci-metadata":
        args.ociMetadataPath = nextValue;
        index += 1;
        break;
      case "--package-tarball":
        args.packageTarballs.push(nextValue);
        index += 1;
        break;
      case "--cwd":
        args.cwd = nextValue;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.version || !args.gitCommit || !args.containerDigest || !args.ociMetadataPath || args.packageTarballs.length === 0) {
    throw new Error("Missing required arguments.");
  }

  return args;
}

async function main() {
  const { outputPath } = await createReleaseManifest(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${outputPath}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
