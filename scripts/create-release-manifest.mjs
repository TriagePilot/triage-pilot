#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
  await assertCleanCheckout(options.gitCommit);

  const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (rootManifest.version !== options.version) {
    throw new Error(`Root package version ${rootManifest.version} does not match ${options.version}.`);
  }

  await assertDockerfileVersion(options.version);

  const packages = [];
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
    if (manifest.version !== options.version) {
      throw new Error(`Package ${manifest.name} version ${manifest.version} does not match ${options.version}.`);
    }

    packages.push({
      name: manifest.name,
      version: manifest.version,
      tarball: basename(absoluteTarballPath),
      sha256: createHash("sha256").update(await readFile(absoluteTarballPath)).digest("hex"),
    });
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));

  const manifest = {
    version: options.version,
    gitCommit: options.gitCommit,
    packages,
    contracts: {
      package: "@triagepilot/contracts",
      sha256: packages.find((entry) => entry.name === "@triagepilot/contracts")?.sha256 ?? null,
    },
    databaseMigration: {
      id: options.databaseMigration,
      package: "@triagepilot/db",
    },
    container: {
      digest: options.containerDigest,
      imageVersion: options.version,
    },
  };

  const outputPath = join(repoRoot, "artifacts", "release-manifest.json");
  await mkdir(join(repoRoot, "artifacts"), { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outputPath, content);
  return { outputPath, content };
}

async function assertCleanCheckout(expectedCommit) {
  const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const actualCommit = headSha.trim();
  if (actualCommit !== expectedCommit) throw new Error(`Expected git commit ${expectedCommit}, got ${actualCommit}.`);

  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.trim().length > 0) throw new Error("Checkout is dirty.");
}

async function assertDockerfileVersion(version) {
  const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
  const versionArg = dockerfile.match(/^ARG TRIAGEPILOT_VERSION=(.+)$/m)?.[1]?.trim();
  const label = dockerfile.match(/^LABEL org\.opencontainers\.image\.version=(.+)$/m)?.[1]?.trim();

  if (versionArg !== version) throw new Error(`Dockerfile ARG version ${versionArg ?? "<missing>"} does not match ${version}.`);
  if (label !== "$TRIAGEPILOT_VERSION") {
    throw new Error(`Dockerfile label ${label ?? "<missing>"} does not match $TRIAGEPILOT_VERSION.`);
  }
}

function parseArgs(argv) {
  const args = {
    packageTarballs: [],
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
        args.databaseMigration = nextValue;
        index += 1;
        break;
      case "--container-digest":
        args.containerDigest = nextValue;
        index += 1;
        break;
      case "--package-tarball":
        args.packageTarballs.push(nextValue);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.version || !args.gitCommit || !args.databaseMigration || !args.containerDigest || args.packageTarballs.length === 0) {
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
