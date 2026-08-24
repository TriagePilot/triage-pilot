import { minimatch } from "minimatch";

import type { RiskTier, ScoreComponent } from "@triagepilot/shared";

export const CLASSIFIER_VERSION = "risk-v2";

export interface ChangedFileMetadata {
  path: string;
  additions: number;
  deletions: number;
}

export interface RiskPathConfig {
  pattern: string;
  weight: number;
  tag: string;
}

export interface RiskSuppressorConfig {
  ifAllMatch: string[];
  ceiling: number;
}

export interface AiAuthorshipConfig {
  enabled: boolean;
  modifier: number;
}

export interface RiskThresholdConfig {
  low: number;
  high: number;
}

export interface RiskSizeConfig {
  highChangedFiles: number;
  highChangedLines: number;
}

export interface RiskScoringConfig {
  size: RiskSizeConfig;
  thresholds: RiskThresholdConfig;
  paths: RiskPathConfig[];
  suppressors: RiskSuppressorConfig[];
  aiAuthorship: AiAuthorshipConfig;
}

export interface RiskScoringInput {
  files: ChangedFileMetadata[];
  author: string;
  branchName: string;
  commitMessages: string[];
  config: RiskScoringConfig;
}

export interface RiskScoringResult {
  classifierVersion: typeof CLASSIFIER_VERSION;
  score: number;
  tier: RiskTier;
  components: ScoreComponent[];
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
]);

const MIGRATION_OR_SCHEMA_PATTERNS = [
  "**/migrations/**",
  "migrations/**",
  "**/migration/**",
  "migration/**",
  "**/schema/**",
  "schema/**",
  "**/schema.sql",
  "**/schema.ts",
  "**/schema.prisma",
  "prisma/schema.prisma",
];

const TEST_PATH_PATTERNS = ["**/*.spec.ts", "**/*.test.ts", "**/__tests__/**", "test/**", "tests/**"];

const AI_BRANCH_PREFIXES = ["codex/", "copilot/", "cursor/", "devin/", "lovable/"];
const AI_AUTHORS = new Set(["copilot", "copilot-swe-agent", "devin-ai-integration", "lovable"]);
const AI_COAUTHOR_MARKERS = ["copilot", "codex", "cursor", "devin", "lovable"];
export function scorePullRequestRisk(input: RiskScoringInput): RiskScoringResult {
  const components: ScoreComponent[] = [];
  const { config, files } = input;
  const scoredFiles = files.filter((file) => !isTestPath(file.path));

  if (scoredFiles.length > 0) {
    components.push({
      reason: "changed_file_count",
      score: Math.min(20, Math.ceil(scoredFiles.length / 5) * 5),
      detail: `${scoredFiles.length} changed file${scoredFiles.length === 1 ? "" : "s"}`,
    });
  }

  const lineDelta = scoredFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (lineDelta >= 200) {
    components.push({
      reason: "large_line_delta",
      score: 15,
      detail: `${lineDelta} changed lines`,
    });
  }

  for (const riskPath of config.paths) {
    const matchedFiles = scoredFiles.filter((file) => matchesPath(file.path, riskPath.pattern));
    if (matchedFiles.length > 0) {
      components.push({
        reason: `high_risk_path:${riskPath.tag}`,
        score: riskPath.weight,
        detail: `${matchedFiles.length} file${matchedFiles.length === 1 ? "" : "s"} matched ${riskPath.pattern}`,
      });
    }
  }

  if (files.some((file) => LOCKFILE_NAMES.has(pathBasename(file.path)))) {
    components.push({
      reason: "dependency_lockfile_change",
      score: 15,
      detail: "Dependency lockfile changed",
    });
  }

  if (files.some((file) => MIGRATION_OR_SCHEMA_PATTERNS.some((pattern) => matchesPath(file.path, pattern)))) {
    components.push({
      reason: "migration_or_schema_change",
      score: 20,
      detail: "Migration or schema file changed",
    });
  }

  if (config.aiAuthorship.enabled && hasAiAuthorshipSignal(input)) {
    components.push({
      reason: "ai_authorship_signal",
      score: config.aiAuthorship.modifier,
      detail: "Author, branch, or commit metadata indicates AI-authored changes",
    });
  }

  const reachedFileThreshold = scoredFiles.length >= config.size.highChangedFiles;
  const reachedLineThreshold = lineDelta >= config.size.highChangedLines;
  const sizeEscalated = reachedFileThreshold || reachedLineThreshold;
  if (sizeEscalated) {
    const scoreFloor = Math.min(100, config.thresholds.high + 1);
    components.push({
      reason: "large_change_size",
      score: Math.max(0, scoreFloor - sumComponentScores(components)),
      detail: formatSizeEscalationDetail({
        changedFiles: scoredFiles.length,
        changedLines: lineDelta,
        highChangedFiles: config.size.highChangedFiles,
        highChangedLines: config.size.highChangedLines,
        reachedFileThreshold,
        reachedLineThreshold,
      }),
    });
  }

  let score = Math.min(100, sumComponentScores(components));

  const suppressor = findMatchingSuppressor(files, config.suppressors);
  if (suppressor) {
    if (!sizeEscalated) {
      score = Math.min(score, suppressor.ceiling);
    }
    components.push({
      reason: "docs_or_test_suppressor",
      score: 0,
      detail: sizeEscalated
        ? "Risk suppressor ignored for a size-escalated pull request"
        : `Risk score capped at ${suppressor.ceiling}`,
    });
  }

  return {
    classifierVersion: CLASSIFIER_VERSION,
    score,
    tier: sizeEscalated ? "high" : tierForScore(score, config),
    components,
  };
}

function sumComponentScores(components: ScoreComponent[]): number {
  return components.reduce((sum, component) => sum + component.score, 0);
}

function tierForScore(score: number, config: RiskScoringConfig): RiskTier {
  if (score <= config.thresholds.low) {
    return "low";
  }

  if (score <= config.thresholds.high) {
    return "medium";
  }

  return "high";
}

function findMatchingSuppressor(
  files: ChangedFileMetadata[],
  suppressors: RiskSuppressorConfig[],
): RiskSuppressorConfig | undefined {
  if (files.length === 0) {
    return undefined;
  }

  return suppressors.find(
    (suppressor) =>
      suppressor.ifAllMatch.length > 0 &&
      files.every((file) => suppressor.ifAllMatch.some((pattern) => matchesPath(file.path, pattern))),
  );
}

function hasAiAuthorshipSignal(input: RiskScoringInput): boolean {
  const author = input.author.toLowerCase();
  const branchName = input.branchName.toLowerCase();

  return (
    AI_AUTHORS.has(author) ||
    AI_BRANCH_PREFIXES.some((prefix) => branchName.startsWith(prefix)) ||
    input.commitMessages.some(hasAiCommitMarker)
  );
}

function hasAiCommitMarker(message: string): boolean {
  return message
    .toLowerCase()
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trimStart().startsWith("co-authored-by:") &&
        AI_COAUTHOR_MARKERS.some((marker) => line.includes(marker)),
    );
}

function matchesPath(path: string, pattern: string): boolean {
  return minimatch(path, pattern, { dot: true, matchBase: true });
}

function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => matchesPath(path, pattern));
}

function formatSizeEscalationDetail({
  changedFiles,
  changedLines,
  highChangedFiles,
  highChangedLines,
  reachedFileThreshold,
  reachedLineThreshold,
}: {
  changedFiles: number;
  changedLines: number;
  highChangedFiles: number;
  highChangedLines: number;
  reachedFileThreshold: boolean;
  reachedLineThreshold: boolean;
}): string {
  const thresholds = [
    reachedFileThreshold && `${highChangedFiles} file threshold`,
    reachedLineThreshold && `${highChangedLines} line threshold`,
  ].filter((threshold): threshold is string => Boolean(threshold));

  return `${changedFiles} non-test changed file${changedFiles === 1 ? "" : "s"}, ${changedLines} non-test changed lines; reached ${thresholds.join(" and ")}`;
}

function pathBasename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
