#!/usr/bin/env node

import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const licenseId = "FSL-1.1-Apache-2.0";
const manifestBackupName = ".triagepilot-package-manifest.backup.json";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageDir = resolve(process.cwd(), options.packageDir);
  const manifestPath = join(packageDir, "package.json");
  const manifestBackupPath = join(packageDir, manifestBackupName);

  if (options.cleanup) {
    try {
      await rename(manifestBackupPath, manifestPath);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    return;
  }

  await cp(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));
  await injectReleaseMetadata(manifestPath, manifestBackupPath);
  for (const { source, target } of options.assets) {
    await cp(join(packageDir, source), join(packageDir, target), { force: true });
  }
}

async function injectReleaseMetadata(manifestPath, manifestBackupPath) {
  const publishedAt = process.env.TRIAGEPILOT_ARTIFACT_PUBLISHED_AT;
  if (!publishedAt) return;

  const futureLicenseEffectiveAt =
    process.env.TRIAGEPILOT_ARTIFACT_FUTURE_LICENSE_EFFECTIVE_AT ?? deriveFutureLicenseEffectiveAt(publishedAt);
  if (futureLicenseEffectiveAt !== deriveFutureLicenseEffectiveAt(publishedAt)) {
    throw new Error("TRIAGEPILOT_ARTIFACT_FUTURE_LICENSE_EFFECTIVE_AT must be the second anniversary of TRIAGEPILOT_ARTIFACT_PUBLISHED_AT.");
  }

  const originalManifestContent = await readFile(manifestPath, "utf8");
  await writeFile(manifestBackupPath, originalManifestContent);
  const manifest = JSON.parse(originalManifestContent);
  manifest.license = licenseId;
  manifest.publishedAt = parseIsoTimestamp(publishedAt, "TRIAGEPILOT_ARTIFACT_PUBLISHED_AT");
  manifest.futureLicenseEffectiveAt = parseIsoTimestamp(
    futureLicenseEffectiveAt,
    "TRIAGEPILOT_ARTIFACT_FUTURE_LICENSE_EFFECTIVE_AT",
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function deriveFutureLicenseEffectiveAt(publishedAt) {
  const date = new Date(parseIsoTimestamp(publishedAt, "TRIAGEPILOT_ARTIFACT_PUBLISHED_AT"));
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date.toISOString();
}

function parseIsoTimestamp(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function parseArgs(args) {
  let packageDir = ".";
  let cleanup = false;
  const assets = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--package") {
      packageDir = args[++index] ?? ".";
      continue;
    }

    if (arg === "--asset") {
      const value = args[++index];
      if (!value || !value.includes("=")) throw new Error("--asset requires SOURCE=TARGET");
      const [source, target] = value.split("=");
      assets.push({ source, target });
      continue;
    }

    if (arg === "--cleanup") {
      cleanup = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { packageDir, cleanup, assets };
}

await main();
