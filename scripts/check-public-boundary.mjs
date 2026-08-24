#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const CONTENT_EXCLUDED_PATHS = new Set([
  "docs/specs/2026-07-07-open-source-self-hosting-design.md",
  "pnpm-lock.yaml",
]);

const forbiddenPaths = [
  { rule: "path:wrangler", pattern: /(^|\/)wrangler(?:\.[^/]*)?$/i },
  { rule: "path:provider-directory", pattern: /(^|\/)(terraform|helm|k8s|cloudflare)(\/|$)/i },
  {
    rule: "path:private-material",
    pattern: /(^|\/)(private|hosted)-?(deployment|runbook|secrets?)(\/|\.|$)/i,
  },
];

const forbiddenContent = [
  { rule: "content:local-workspace-path", pattern: /(?:^|[^A-Za-z0-9])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/ },
  { rule: "content:provider-binding", pattern: new RegExp(["hyper", "drive"].join(""), "i") },
  { rule: "content:provider-config", pattern: new RegExp(["wrangler", "\\.toml"].join(""), "i") },
  { rule: "content:provider-queue", pattern: new RegExp(["cloudflare", "\\s+queues"].join(""), "i") },
  { rule: "content:provider-cron", pattern: new RegExp(["cloudflare", "\\s+cron"].join(""), "i") },
];

export function findPathViolations(path) {
  return forbiddenPaths
    .filter(({ pattern }) => pattern.test(path))
    .map(({ rule }) => ({ path, rule }));
}

export function findContentViolations(path, content) {
  if (CONTENT_EXCLUDED_PATHS.has(path)) return [];

  return forbiddenContent
    .filter(({ pattern }) => pattern.test(content))
    .map(({ rule }) => ({ path, rule }));
}

export function formatViolation(violation) {
  return `${violation.path}\t${violation.rule}`;
}

export async function scanPublicBoundary({ cwd = process.cwd() } = {}) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const trackedPaths = stdout.toString("utf8").split("\0").filter(Boolean);
  const violations = [];

  for (const path of trackedPaths) {
    violations.push(...findPathViolations(path));

    const content = await readTrackedText(cwd, path);
    if (content !== null) violations.push(...findContentViolations(path, content));
  }

  return violations;
}

async function readTrackedText(cwd, path) {
  const absolutePath = join(cwd, path);
  let metadata;

  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  let content;
  if (metadata.isSymbolicLink()) {
    content = Buffer.from(await readlink(absolutePath), "utf8");
  } else if (metadata.isFile()) {
    if (metadata.size >= MAX_TEXT_FILE_BYTES) return null;
    content = await readFile(absolutePath);
  } else {
    return null;
  }

  if (content.byteLength >= MAX_TEXT_FILE_BYTES || content.includes(0)) return null;
  return content.toString("utf8");
}

async function main() {
  const violations = await scanPublicBoundary();
  for (const violation of violations) console.error(formatViolation(violation));
  if (violations.length > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
