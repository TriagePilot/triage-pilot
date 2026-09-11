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
const sortedPublishedPackages = [...publishedPackages].sort((left, right) => left.localeCompare(right));
const licenseId = "FSL-1.1-Apache-2.0";
const imageLicenseLabel = "org.opencontainers.image.licenses";
const imageRevisionLabel = "org.opencontainers.image.revision";
const imagePublishedAtLabel = "org.opencontainers.image.created";
const imageFutureLicenseEffectiveAtLabel = "org.triagepilot.future-license-effective-at";
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const requiredHistoricalMigrations = [
  "0005_reviewer_availability.sql",
  "0005_workspace_scope.sql",
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
  const publishedAt = parseIsoTimestamp(options.publishedAt, "publishedAt");
  const futureLicenseEffectiveAt = deriveFutureLicenseEffectiveAt(publishedAt);

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
    if (manifest.license !== licenseId) {
      throw new Error(`Package ${manifest.name} license ${manifest.license} does not match ${licenseId}.`);
    }
    if (manifest.publishedAt !== publishedAt) {
      throw new Error(`Package ${manifest.name} publishedAt ${manifest.publishedAt} does not match ${publishedAt}.`);
    }
    if (manifest.futureLicenseEffectiveAt !== futureLicenseEffectiveAt) {
      throw new Error(
        `Package ${manifest.name} futureLicenseEffectiveAt ${manifest.futureLicenseEffectiveAt} does not match ${futureLicenseEffectiveAt}.`,
      );
    }
    seenPackages.add(manifest.name);

    packages.push({
      name: manifest.name,
      version: manifest.version,
      publishedAt: manifest.publishedAt,
      futureLicenseEffectiveAt: manifest.futureLicenseEffectiveAt,
      tarball: basename(absoluteTarballPath),
      sha256: createHash("sha256").update(await readFile(absoluteTarballPath)).digest("hex"),
    });
  }

  const missingPackages = publishedPackages.filter((packageName) => !seenPackages.has(packageName));
  if (missingPackages.length > 0) {
    throw new Error(`Missing required package tarballs: ${missingPackages.join(", ")}.`);
  }

  const imageMetadata = await readImageReleaseMetadata(options.ociMetadataPath, options.containerDigest);
  if (imageMetadata.version !== options.version) {
    throw new Error(`OCI metadata annotation org.opencontainers.image.version ${imageMetadata.version} does not match ${options.version}.`);
  }
  if (imageMetadata.license !== licenseId) {
    throw new Error(`OCI metadata annotation ${imageLicenseLabel} ${imageMetadata.license} does not match ${licenseId}.`);
  }
  if (imageMetadata.revision !== options.gitCommit) {
    throw new Error(`OCI metadata annotation ${imageRevisionLabel} ${imageMetadata.revision} does not match ${options.gitCommit}.`);
  }
  if (imageMetadata.publishedAt !== publishedAt) {
    throw new Error(`OCI metadata annotation ${imagePublishedAtLabel} ${imageMetadata.publishedAt} does not match ${publishedAt}.`);
  }
  if (imageMetadata.futureLicenseEffectiveAt !== futureLicenseEffectiveAt) {
    throw new Error(
      `OCI metadata annotation ${imageFutureLicenseEffectiveAtLabel} ${imageMetadata.futureLicenseEffectiveAt} does not match ${futureLicenseEffectiveAt}.`,
    );
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));
  const contractsPackage = packages.find((entry) => entry.name === "@triagepilot/contracts");
  if (!contractsPackage) throw new Error("Missing required contracts artifact.");

  const manifest = {
    version: options.version,
    gitCommit: options.gitCommit,
    license: licenseId,
    publishedAt,
    futureLicenseEffectiveAt,
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
      imageVersion: imageMetadata.version,
      publishedAt,
      futureLicenseEffectiveAt,
    },
  };
  validateReleaseManifest(manifest, {
    version: options.version,
    gitCommit: options.gitCommit,
    databaseMigration: highestMigration,
    containerDigest: options.containerDigest,
  });

  const outputPath = join(repoRoot, "artifacts", "release-manifest.json");
  await mkdir(join(repoRoot, "artifacts"), { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outputPath, content);
  return { outputPath, content };
}

export function validateReleaseManifest(manifest, expectations) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be an object.");
  }
  if (manifest.version !== expectations.version) {
    throw new Error(`Release manifest version ${manifest.version} does not match ${expectations.version}.`);
  }
  if (manifest.gitCommit !== expectations.gitCommit) {
    throw new Error(`Release manifest git commit ${manifest.gitCommit} does not match ${expectations.gitCommit}.`);
  }
  if (manifest.license !== licenseId) {
    throw new Error(`Release manifest license must be ${licenseId}.`);
  }
  const publishedAt = parseIsoTimestamp(manifest.publishedAt, "publishedAt");
  const futureLicenseEffectiveAt = parseIsoTimestamp(manifest.futureLicenseEffectiveAt, "futureLicenseEffectiveAt");
  if (futureLicenseEffectiveAt !== deriveFutureLicenseEffectiveAt(publishedAt)) {
    throw new Error("Release manifest futureLicenseEffectiveAt must be the second anniversary of publishedAt.");
  }

  if (!Array.isArray(manifest.packages)) {
    throw new Error("Release manifest packages must be an array.");
  }
  if (manifest.packages.length !== sortedPublishedPackages.length) {
    throw new Error(`Release manifest must contain ${sortedPublishedPackages.length} packages.`);
  }

  const seenPackages = new Set();
  const packageNames = manifest.packages.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Release manifest package entries must be objects.");
    }
    if (!sortedPublishedPackages.includes(entry.name)) {
      throw new Error(`Unexpected published package ${entry.name}.`);
    }
    if (seenPackages.has(entry.name)) {
      throw new Error(`Duplicate package tarball for ${entry.name}.`);
    }
    seenPackages.add(entry.name);

    if (entry.version !== expectations.version) {
      throw new Error(`Package ${entry.name} version ${entry.version} does not match ${expectations.version}.`);
    }
    if (entry.publishedAt !== publishedAt) {
      throw new Error(`Package ${entry.name} publishedAt ${entry.publishedAt} does not match ${publishedAt}.`);
    }
    if (entry.futureLicenseEffectiveAt !== futureLicenseEffectiveAt) {
      throw new Error(
        `Package ${entry.name} futureLicenseEffectiveAt ${entry.futureLicenseEffectiveAt} does not match ${futureLicenseEffectiveAt}.`,
      );
    }
    if (typeof entry.tarball !== "string" || entry.tarball.length === 0) {
      throw new Error(`Package ${entry.name} tarball is missing.`);
    }
    if (typeof entry.sha256 !== "string" || !shaPattern.test(entry.sha256)) {
      throw new Error(`Package ${entry.name} sha256 must be a 64-character lowercase hex digest.`);
    }
    return entry.name;
  });

  const sortedPackageNames = [...packageNames].sort((left, right) => left.localeCompare(right));
  if (packageNames.some((name, index) => name !== sortedPackageNames[index])) {
    throw new Error("Release manifest packages are not sorted by name.");
  }
  const missingPackages = sortedPublishedPackages.filter((packageName) => !seenPackages.has(packageName));
  if (missingPackages.length > 0) {
    throw new Error(`Missing required package tarballs: ${missingPackages.join(", ")}.`);
  }

  if (!manifest.contracts || typeof manifest.contracts !== "object" || Array.isArray(manifest.contracts)) {
    throw new Error("Release manifest contracts metadata is missing.");
  }
  if (manifest.contracts.package !== "@triagepilot/contracts") {
    throw new Error(`Release manifest contracts package ${manifest.contracts.package} must be @triagepilot/contracts.`);
  }
  if (typeof manifest.contracts.sha256 !== "string" || !shaPattern.test(manifest.contracts.sha256)) {
    throw new Error("Release manifest contracts digest must be a 64-character lowercase hex digest.");
  }
  const contractsPackage = manifest.packages.find((entry) => entry.name === "@triagepilot/contracts");
  if (!contractsPackage) throw new Error("Missing required contracts artifact.");
  if (contractsPackage.sha256 !== manifest.contracts.sha256) {
    throw new Error("Release manifest contracts digest does not match the contracts package digest.");
  }

  if (!manifest.databaseMigration || typeof manifest.databaseMigration !== "object" || Array.isArray(manifest.databaseMigration)) {
    throw new Error("Release manifest database migration metadata is missing.");
  }
  if (manifest.databaseMigration.package !== "@triagepilot/db") {
    throw new Error(`Release manifest database migration package ${manifest.databaseMigration.package} must be @triagepilot/db.`);
  }
  if (manifest.databaseMigration.id !== expectations.databaseMigration) {
    throw new Error(
      `Release manifest database migration ${manifest.databaseMigration.id} does not match ${expectations.databaseMigration}.`,
    );
  }

  if (!manifest.container || typeof manifest.container !== "object" || Array.isArray(manifest.container)) {
    throw new Error("Release manifest container metadata is missing.");
  }
  if (typeof manifest.container.digest !== "string" || manifest.container.digest.length === 0) {
    throw new Error("Release manifest container digest is missing.");
  }
  if (!digestPattern.test(manifest.container.digest)) {
    throw new Error(`Release manifest container digest ${manifest.container.digest} is invalid.`);
  }
  if (manifest.container.digest !== expectations.containerDigest) {
    throw new Error(
      `Release manifest container digest ${manifest.container.digest} does not match ${expectations.containerDigest}.`,
    );
  }
  if (manifest.container.imageVersion !== expectations.version) {
    throw new Error(`Release manifest image version ${manifest.container.imageVersion} does not match ${expectations.version}.`);
  }
  if (manifest.container.publishedAt !== publishedAt) {
    throw new Error(`Release manifest container publishedAt ${manifest.container.publishedAt} does not match ${publishedAt}.`);
  }
  if (manifest.container.futureLicenseEffectiveAt !== futureLicenseEffectiveAt) {
    throw new Error(
      `Release manifest container futureLicenseEffectiveAt ${manifest.container.futureLicenseEffectiveAt} does not match ${futureLicenseEffectiveAt}.`,
    );
  }

  return manifest;
}

export async function findHighestDatabaseMigration(repoRoot) {
  const migrationDir = join(repoRoot, "packages", "db", "migrations");
  const migrations = (await readdir(migrationDir))
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .sort();
  for (const requiredMigration of requiredHistoricalMigrations) {
    if (!migrations.includes(requiredMigration)) {
      throw new Error(`Missing required historical database migration ${requiredMigration}.`);
    }
  }
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
  return (await readImageReleaseMetadata(ociMetadataPath, digest)).version;
}

export async function readImageReleaseMetadata(ociMetadataPath, digest) {
  const metadata = JSON.parse(await readFile(ociMetadataPath, "utf8"));
  const candidates = Array.isArray(metadata) ? metadata : [metadata];
  const match = candidates.find((candidate) => metadataMatchesDigest(candidate, digest));
  if (!match) {
    throw new Error(`OCI metadata does not describe digest ${digest}.`);
  }

  const annotations = readAnnotations(match);
  const version = annotations["org.opencontainers.image.version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("OCI metadata is missing annotation org.opencontainers.image.version.");
  }
  const imageLicense = annotations[imageLicenseLabel];
  if (typeof imageLicense !== "string" || imageLicense.length === 0) {
    throw new Error(`OCI metadata is missing annotation ${imageLicenseLabel}.`);
  }
  const revision = annotations[imageRevisionLabel];
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error(`OCI metadata is missing annotation ${imageRevisionLabel}.`);
  }
  const publishedAt = annotations[imagePublishedAtLabel];
  if (typeof publishedAt !== "string" || publishedAt.length === 0) {
    throw new Error(`OCI metadata is missing annotation ${imagePublishedAtLabel}.`);
  }
  const futureLicenseEffectiveAt = annotations[imageFutureLicenseEffectiveAtLabel];
  if (typeof futureLicenseEffectiveAt !== "string" || futureLicenseEffectiveAt.length === 0) {
    throw new Error(`OCI metadata is missing annotation ${imageFutureLicenseEffectiveAtLabel}.`);
  }
  return { version, license: imageLicense, revision, publishedAt, futureLicenseEffectiveAt };
}

function metadataMatchesDigest(candidate, digest) {
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.digest === digest) return true;
  if (candidate["containerimage.digest"] === digest) return true;
  if (
    candidate["containerimage.descriptor"] &&
    typeof candidate["containerimage.descriptor"] === "object" &&
    candidate["containerimage.descriptor"].digest === digest
  ) {
    return true;
  }
  const repoDigests = [
    ...(Array.isArray(candidate.repoDigests) ? candidate.repoDigests : []),
    ...(Array.isArray(candidate.RepoDigests) ? candidate.RepoDigests : []),
  ];
  return repoDigests.some((entry) => typeof entry === "string" && entry.endsWith(`@${digest}`));
}

function readAnnotations(candidate) {
  const annotations = {};
  if (!candidate || typeof candidate !== "object") return annotations;

  for (const source of [
    candidate.annotations,
    candidate.Annotations,
    candidate["containerimage.descriptor"]?.annotations,
  ]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (annotations[key] !== undefined && annotations[key] !== value) {
        throw new Error(`OCI metadata annotation ${key} has conflicting values.`);
      }
      annotations[key] = value;
    }
  }

  return annotations;
}

export function deriveFutureLicenseEffectiveAt(publishedAt) {
  const date = new Date(parseIsoTimestamp(publishedAt, "publishedAt"));
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date.toISOString();
}

function parseIsoTimestamp(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Release manifest ${label} must be an ISO timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Release manifest ${label} must be an ISO timestamp.`);
  }
  return value;
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
      case "--published-at":
        args.publishedAt = nextValue;
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

  if (!args.version || !args.gitCommit || !args.containerDigest || !args.publishedAt || !args.ociMetadataPath || args.packageTarballs.length === 0) {
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
