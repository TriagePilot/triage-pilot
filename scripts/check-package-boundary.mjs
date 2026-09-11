#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publishedPackages = [
  {
    dir: "packages/contracts",
    name: "@triagepilot/contracts",
    files: ["dist", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/config",
    name: "@triagepilot/config",
    files: ["dist", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/core",
    name: "@triagepilot/core",
    files: ["dist", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/application",
    name: "@triagepilot/application",
    files: ["dist", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/db",
    name: "@triagepilot/db",
    files: ["dist", "migrations", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/provider-github",
    name: "@triagepilot/provider-github",
    files: ["dist", "LICENSE"],
    extraExports: {},
  },
  {
    dir: "packages/ui",
    name: "@triagepilot/ui",
    files: ["dist", "LICENSE"],
    extraExports: { "./styles.css": "./dist/styles.css" },
  },
];

const publishedPackageNames = new Set(publishedPackages.map((entry) => entry.name));
const forbiddenProtocols = [/^workspace:/, /^file:/, /^link:/, /^git\+/, /^git:/, /^https?:\/\/.*\.git(?:#.*)?$/];

export async function scanPackageBoundary({ cwd = repoRoot } = {}) {
  const rootManifest = await readJson(join(cwd, "package.json"));
  const rootVersion = readString(rootManifest.version, "root package.json version");
  const violations = [];

  for (const expectedPackage of publishedPackages) {
    const packageRoot = join(cwd, expectedPackage.dir);
    const manifest = await readJson(join(packageRoot, "package.json"));
    const manifestLabel = relative(cwd, join(packageRoot, "package.json"));

    if (readString(manifest.name, `${manifestLabel} name`) !== expectedPackage.name) {
      violations.push({ path: manifestLabel, rule: "manifest:name-mismatch" });
    }

    if (readString(manifest.version, `${manifestLabel} version`) !== rootVersion) {
      violations.push({ path: manifestLabel, rule: "manifest:version-mismatch" });
    }

    if (manifest.private === true) violations.push({ path: manifestLabel, rule: "manifest:private" });
    if (readString(manifest.main, `${manifestLabel} main`) !== "./dist/index.js") {
      violations.push({ path: manifestLabel, rule: "manifest:main" });
    }
    if (readString(manifest.types, `${manifestLabel} types`) !== "./dist/index.d.ts") {
      violations.push({ path: manifestLabel, rule: "manifest:types" });
    }

    const files = readStringArray(manifest.files, `${manifestLabel} files`);
    if (JSON.stringify(files) !== JSON.stringify(expectedPackage.files)) {
      violations.push({ path: manifestLabel, rule: "manifest:files" });
    }

    const publishConfig = readRecord(manifest.publishConfig, `${manifestLabel} publishConfig`);
    if (readString(publishConfig.access, `${manifestLabel} publishConfig.access`) !== "public") {
      violations.push({ path: manifestLabel, rule: "manifest:publish-access" });
    }

    const exportsField = readRecord(manifest.exports, `${manifestLabel} exports`);
    const dotExport = readRecord(exportsField["."], `${manifestLabel} exports["."]`);
    if (readString(dotExport.types, `${manifestLabel} exports["."].types`) !== "./dist/index.d.ts") {
      violations.push({ path: manifestLabel, rule: "exports:types" });
    }
    if (readString(dotExport.import, `${manifestLabel} exports["."].import`) !== "./dist/index.js") {
      violations.push({ path: manifestLabel, rule: "exports:import" });
    }

    const exportKeys = Object.keys(exportsField).sort();
    const expectedExportKeys = [".", ...Object.keys(expectedPackage.extraExports)].sort();
    if (JSON.stringify(exportKeys) !== JSON.stringify(expectedExportKeys)) {
      violations.push({ path: manifestLabel, rule: "exports:keys" });
    }
    for (const [key, value] of Object.entries(expectedPackage.extraExports)) {
      if (exportsField[key] !== value) violations.push({ path: manifestLabel, rule: `exports:${key}` });
    }

    for (const [section, dependencyName, version] of iterateDependencyVersions(manifest)) {
      if (forbiddenProtocols.some((pattern) => pattern.test(version))) {
        if (!publishedPackageNames.has(dependencyName) || version !== `workspace:${rootVersion}`) {
          violations.push({ path: manifestLabel, rule: `${section}:forbidden-protocol:${dependencyName}` });
        }
      }

      if (!dependencyName.startsWith("@triagepilot/")) continue;
      if (dependencyName === "@triagepilot/shared") {
        violations.push({ path: manifestLabel, rule: `${section}:shared-import` });
        continue;
      }

      if (!publishedPackageNames.has(dependencyName)) {
        violations.push({ path: manifestLabel, rule: `${section}:unpublished-internal:${dependencyName}` });
        continue;
      }

      if (version !== `workspace:${rootVersion}`) {
        violations.push({ path: manifestLabel, rule: `${section}:version-sync:${dependencyName}` });
      }
    }

    violations.push(...(await scanDeclarationOutputs(cwd, expectedPackage.dir)));
  }

  return violations;
}

export function formatViolation(violation) {
  return `${violation.path}\t${violation.rule}`;
}

async function scanDeclarationOutputs(cwd, packageDir) {
  const packageRoot = join(cwd, packageDir);
  const distRoot = join(packageRoot, "dist");
  const distFiles = await walkFiles(distRoot);
  const violations = [];

  if (!(await pathExists(join(distRoot, "index.js")))) {
    violations.push({ path: relative(cwd, join(distRoot, "index.js")), rule: "dist:missing-js-entry" });
  }
  if (!(await pathExists(join(distRoot, "index.d.ts")))) {
    violations.push({ path: relative(cwd, join(distRoot, "index.d.ts")), rule: "dist:missing-types-entry" });
  }

  for (const file of distFiles) {
    const relativePath = relative(cwd, file);
    const content = await readFile(file, "utf8");
    if (/@triagepilot\/shared/.test(content)) violations.push({ path: relativePath, rule: "dist:shared-reference" });
    if (/(^|["'])\.\.?\/src\//m.test(content)) violations.push({ path: relativePath, rule: "dist:source-reference" });
    if (/\/Users\/|\/home\//.test(content)) violations.push({ path: relativePath, rule: "dist:absolute-path" });
    if (/from\s+["'][^"']*apps\//.test(content)) violations.push({ path: relativePath, rule: "dist:apps-import" });
  }

  return violations;
}

async function walkFiles(root) {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function iterateDependencyVersions(manifest) {
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const entries = [];

  for (const section of sections) {
    const value = manifest[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [dependencyName, version] of Object.entries(value)) {
      entries.push([section, dependencyName, readString(version, `${section}.${dependencyName}`)]);
    }
  }

  return entries;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function readString(value, label) {
  if (typeof value !== "string") throw new TypeError(`Expected ${label} to be a string.`);
  return value;
}

function readStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`Expected ${label} to be a string array.`);
  }
  return value;
}

function readRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }
  return value;
}

async function main() {
  const violations = await scanPackageBoundary();
  for (const violation of violations) console.error(formatViolation(violation));
  if (violations.length > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
