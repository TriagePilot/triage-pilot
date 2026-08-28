#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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

  const release = await ensureGitHubRelease(
    {
      tagName: options.tagName,
      title: `TriagePilot ${options.version}`,
      releaseNotesPath: verification.releaseNotesPath,
      releaseNotes,
    },
    command,
  );
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

  return { release, container, packages };
}

async function ensureGitHubRelease(options, command) {
  const existing = await command("gh", ["release", "view", options.tagName, "--json", "body"], { allowFailure: true });
  if (existing.exitCode === 0) {
    const parsed = JSON.parse(existing.stdout);
    if (parsed.body !== options.releaseNotes) {
      throw new Error(`GitHub release ${options.tagName} already exists with notes that do not match artifacts/release-notes.md.`);
    }
    return "matched";
  }

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
  return "created";
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
  const configResult = await command("oras", ["manifest", "fetch-config", reference]);
  const manifest = JSON.parse(manifestResult.stdout);
  const config = JSON.parse(configResult.stdout);
  const annotations = readRecord(manifest.annotations, "published image annotations");
  const labels = readRecord(config?.config?.Labels, "published image config labels");

  for (const key of imageMetadataKeys) {
    if (annotations[key] !== expectedValues[key]) {
      throw new Error(`Published image annotation ${key} ${annotations[key]} does not match ${expectedValues[key]}.`);
    }
    if (labels[key] !== expectedValues[key]) {
      throw new Error(`Published image label ${key} ${labels[key]} does not match ${expectedValues[key]}.`);
    }
  }
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
  validateTarEntries(await listTarEntries(imageTarPath));
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

async function listTarEntries(tarPath) {
  const archive = await readFile(tarPath);
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header, 124, 12);
    entries.push(entryName);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validateTarEntries(entries) {
  for (const entry of entries) {
    const normalizedEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (normalizedEntry.length === 0 || posix.isAbsolute(normalizedEntry) || normalizedEntry.includes("\\")) {
      throw new Error(`Unsafe OCI layout archive entry ${entry}.`);
    }
    const segments = normalizedEntry.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error(`Unsafe OCI layout archive entry ${entry}.`);
    }
  }
}

function readTarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  const sliceEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.toString("utf8", offset, sliceEnd).trim();
}

function parseTarOctal(header, offset, length) {
  const raw = readTarString(header, offset, length).trim();
  if (raw.length === 0) return 0;
  const size = Number.parseInt(raw, 8);
  if (!Number.isFinite(size)) throw new Error("Invalid OCI layout archive entry size.");
  return size;
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
