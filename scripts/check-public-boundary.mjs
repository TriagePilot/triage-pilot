#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const CONTENT_EXCLUDED_PATHS = new Set([
  "pnpm-lock.yaml",
]);
const ALLOWED_VIOLATIONS_BY_PATH = new Map([
  ["LICENSE", new Set(["content:commercial"])],
  ["README.md", new Set(["content:commercial", "content:saas"])],
  ["CONTRIBUTING.md", new Set(["content:commercial"])],
  [".github/PULL_REQUEST_TEMPLATE.md", new Set(["content:commercial"])],
  [
    "AGENTS.md",
    new Set(["content:hosted", "content:private-deployment"]),
  ],
  [
    "docs/specs/2026-07-07-open-source-self-hosting-design.md",
    new Set([
      "content:commercial",
      "content:saas",
      "content:hosted",
      "content:enterprise",
      "content:tenant-id",
      "content:stripe",
      "content:secret-manager",
      "content:provider-binding",
      "content:provider-config",
      "content:provider-queue",
      "content:provider-cron",
    ]),
  ],
  [
    "docs/specs/2026-08-26-commercial-saas-extension-design.md",
    new Set(["content:commercial", "content:saas", "content:hosted", "content:enterprise", "content:tenant-id", "content:stripe", "content:secret-manager"]),
  ],
  [
    "docs/operations/deployment-overlays.md",
    new Set(["content:hosted", "content:secret-manager"]),
  ],
  [
    "scripts/check-public-boundary.mjs",
    new Set(["content:commercial", "content:enterprise", "content:tenant-id", "content:stripe", "content:secret-manager", "content:hosted", "content:saas", "content:active-agpl"]),
  ],
  [
    "test/package-artifacts.test.ts",
    new Set(["content:active-agpl"]),
  ],
  [
    "test/public-boundary.test.ts",
    new Set(["content:active-agpl", "content:saas"]),
  ],
  [
    "test/release-manifest.test.ts",
    new Set(["content:active-agpl"]),
  ],
]);
const HISTORICAL_OR_THIRD_PARTY_PATHS = [
  /^docs\/plans\//,
  /^docs\/specs\/\d{4}-\d{2}-\d{2}-/,
  /^docs\/third-party-notices\//,
  /(^|\/)(?:NOTICE|THIRD_PARTY_NOTICES)(?:\.md|\.txt)?$/i,
];
const LICENSE_ID = "FSL-1.1-Apache-2.0";
const FSL_TITLE = "Functional Source License, Version 1.1, Apache 2.0 Future License";
const STALE_AGPL_PATTERN = /AGPL-3\.0|GNU Affero General Public License|Affero GPL/i;

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
  { rule: "content:active-agpl", pattern: STALE_AGPL_PATTERN },
  { rule: "content:provider-binding", pattern: new RegExp(["hyper", "drive"].join(""), "i") },
  { rule: "content:provider-config", pattern: new RegExp(["wrangler", "\\.toml"].join(""), "i") },
  { rule: "content:provider-queue", pattern: new RegExp(["cloudflare", "\\s+queues"].join(""), "i") },
  { rule: "content:provider-cron", pattern: new RegExp(["cloudflare", "\\s+cron"].join(""), "i") },
  { rule: "content:commercial", pattern: /\bcommercial\b/i },
  { rule: "content:saas", pattern: /\bsaas\b/i },
  { rule: "content:hosted", pattern: /(?<!self[- ])hosted\b/i },
  { rule: "content:enterprise", pattern: /\benterprise\b/i },
  { rule: "content:tenant-id", pattern: /\btenant[_ -]?id\b/i },
  { rule: "content:stripe", pattern: /\bstripe\b/i },
  { rule: "content:private-deployment", pattern: /\bprivate deployment\b/i },
  { rule: "content:secret-manager", pattern: /\bsecret[ -]?manager\b/i },
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
    .map(({ rule }) => ({ path, rule }))
    .filter((violation) => !isAllowedViolation(violation));
}

export function isAllowedViolation(violation) {
  const allowedRules = ALLOWED_VIOLATIONS_BY_PATH.get(violation.path);
  return (allowedRules?.has(violation.rule) ?? false) || isAllowedHistoricalOrThirdPartyViolation(violation);
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
  const trackedText = new Map();

  for (const path of trackedPaths) {
    violations.push(...findPathViolations(path));

    const content = await readTrackedText(cwd, path);
    if (content !== null) {
      trackedText.set(path, content);
      violations.push(...findContentViolations(path, content));
    }
  }

  violations.push(...findLicensingGovernanceViolations(trackedPaths, trackedText));
  return violations;
}

export function findLicensingGovernanceViolations(trackedPaths, trackedText) {
  const trackedPathSet = new Set(trackedPaths);
  const violations = [];

  requireTrackedPath(violations, trackedPathSet, "LICENSE", "license:file-missing");
  requireText(violations, trackedText, "LICENSE", "license:fsl-id-missing", (content) => content.includes(LICENSE_ID));
  requireText(violations, trackedText, "LICENSE", "license:fsl-title-missing", (content) => content.includes(FSL_TITLE));
  requireText(violations, trackedText, "LICENSE", "license:triagepilot-notice-missing", (content) =>
    content.includes("Copyright 2026 Miroslav Babjak"),
  );

  requireText(violations, trackedText, "README.md", "readme:fsl-id-missing", (content) => content.includes(LICENSE_ID));
  requireText(violations, trackedText, "README.md", "readme:fair-source-explanation-missing", (content) =>
    /\bFair Source\b|\bsource-available\b/i.test(content),
  );
  requireText(violations, trackedText, "README.md", "readme:internal-self-hosting-boundary-missing", (content) =>
    /\binternal\b/i.test(content) && /\bself-host/i.test(content),
  );
  requireText(violations, trackedText, "README.md", "readme:future-license-conversion-missing", (content) =>
    /\bApache 2\.0\b/i.test(content) && /\b(?:second anniversary|two-year|2-year)\b/i.test(content),
  );
  requireText(violations, trackedText, "README.md", "readme:proprietary-saas-boundary-missing", (content) =>
    /\bproprietary\b/i.test(content) && /\bSaaS\b/i.test(content),
  );

  requireText(
    violations,
    trackedText,
    "CONTRIBUTING.md",
    "contributing:external-code-docs-closed-missing",
    (content) =>
      /\bexternal\b/i.test(content) &&
      /\bcode\b/i.test(content) &&
      /\bdocumentation\b/i.test(content) &&
      /\b(?:not merged|not accepted|do not merge|closed)\b/i.test(content),
  );
  requireText(
    violations,
    trackedText,
    "CONTRIBUTING.md",
    "contributing:automated-provenance-missing",
    (content) => /\bautomat(?:ed|ion)\b/i.test(content) && /\bprovenance\b/i.test(content),
  );
  requireText(
    violations,
    trackedText,
    "CONTRIBUTING.md",
    "contributing:dependency-license-review-missing",
    (content) =>
      /\bdepend(?:ency|encies|abot)\b/i.test(content) &&
      /\bprovenance\b/i.test(content) &&
      /\blicense[- ]review\b/i.test(content),
  );

  requireTrackedPath(
    violations,
    trackedPathSet,
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull-request-template:file-missing",
  );
  requireText(
    violations,
    trackedText,
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull-request-template:closed-external-contributions-missing",
    (content) =>
      /\bexternal\b/i.test(content) &&
      /\bcode\b/i.test(content) &&
      /\bdocumentation\b/i.test(content) &&
      /\b(?:not merged|not accepted|do not merge|closed)\b/i.test(content),
  );

  return violations;
}

function requireTrackedPath(violations, trackedPathSet, path, rule) {
  if (!trackedPathSet.has(path)) violations.push({ path, rule });
}

function requireText(violations, trackedText, path, rule, predicate) {
  const content = trackedText.get(path);
  if (typeof content !== "string" || !predicate(content)) violations.push({ path, rule });
}

function isAllowedHistoricalOrThirdPartyViolation(violation) {
  if (violation.rule !== "content:active-agpl") return false;
  return HISTORICAL_OR_THIRD_PARTY_PATHS.some((pattern) => pattern.test(violation.path));
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
