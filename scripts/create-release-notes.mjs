#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateReleaseManifest } from "./create-release-manifest.mjs";

export async function createReleaseNotes(options) {
  const manifestPath = resolve(options.manifestPath);
  const outputPath = resolve(options.outputPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateReleaseManifest(manifest, {
    version: manifest.version,
    gitCommit: manifest.gitCommit,
    databaseMigration: manifest.databaseMigration?.id,
    containerDigest: manifest.container?.digest,
  });
  const content = renderReleaseNotes(manifest);
  await writeFile(outputPath, content);
  return { outputPath, content };
}

export function renderReleaseNotes(manifest) {
  const lines = [
    `# TriagePilot ${manifest.version}`,
    "",
    "## Release Metadata",
    "",
    `- License: ${manifest.license}`,
    `- Artifact published at: ${manifest.publishedAt}`,
    `- Artifact future license effective at: ${manifest.futureLicenseEffectiveAt}`,
    `- Source commit: ${manifest.gitCommit}`,
    `- Database migration: ${manifest.databaseMigration.id}`,
    `- Container image digest: ${manifest.container.digest}`,
    "",
    "## Package Artifacts",
    "",
    ...manifest.packages.map((entry) => `- ${entry.name} ${entry.version}: ${entry.sha256}`),
    "",
    "## Licensing Notes",
    "",
    "Artifact timestamps describe publication provenance and do not override an earlier source-availability date recorded by public Git history.",
    "Third-party components retain their own licenses and required notices.",
    "",
  ];
  return `${lines.join("\n")}`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];
    switch (arg) {
      case "--manifest":
        args.manifestPath = nextValue;
        index += 1;
        break;
      case "--output":
        args.outputPath = nextValue;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.manifestPath || !args.outputPath) throw new Error("Missing required arguments.");
  return args;
}

async function main() {
  const { outputPath } = await createReleaseNotes(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${outputPath}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
