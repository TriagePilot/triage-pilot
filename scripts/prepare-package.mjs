#!/usr/bin/env node

import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageDir = resolve(process.cwd(), options.packageDir);

  if (options.cleanup) {
    return;
  }

  await cp(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));
  for (const { source, target } of options.assets) {
    await cp(join(packageDir, source), join(packageDir, target), { force: true });
  }
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
