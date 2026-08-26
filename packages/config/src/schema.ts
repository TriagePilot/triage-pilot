import { parse } from "yaml";
import { z } from "zod";

import type { RepositoryMode } from "@triagepilot/contracts";

export interface ConfigDiagnostic {
  path: string;
  message: string;
}

export type ConfigParseResult =
  | { ok: true; config: TriagePilotConfig; diagnostics: [] }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

export interface ConfigurationDocumentValue {
  inheritance?: boolean;
  [key: string]: unknown;
}

export type ConfigDocumentResult =
  | { ok: true; document: ConfigurationDocumentValue; diagnostics: [] }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

const reviewerHandleSchema = z.string().regex(/^@[A-Za-z0-9_.-]+$/, {
  message: "reviewer must be an individual GitHub user handle such as @sasha; teams are not supported",
});
const repositoryModeSchema: z.ZodType<RepositoryMode> = z.enum(["shadow", "enforce"]);

const routingDocumentSchema = z.object({
  high_risk_reviewers: z.union([z.literal(1), z.literal(2)]).optional(),
  exclude_target_branches: z.array(z.string().min(1)).optional(),
  exclude_source_branch_patterns: z.array(z.string().min(1)).optional(),
  include_draft_pull_requests: z.boolean().optional(),
}).strict();
const routingInputSchema = z.object({
  high_risk_reviewers: z.union([z.literal(1), z.literal(2)]).default(1),
  exclude_target_branches: z.array(z.string().min(1)).default([]),
  exclude_source_branch_patterns: z.array(z.string().min(1)).default([]),
  include_draft_pull_requests: z.boolean().default(false),
}).strict().default({}).transform((routing) => ({
  highRiskReviewers: routing.high_risk_reviewers,
  excludeTargetBranches: routing.exclude_target_branches,
  excludeSourceBranchPatterns: routing.exclude_source_branch_patterns,
  includeDraftPullRequests: routing.include_draft_pull_requests,
}));

const riskPathSchema = z.object({
  pattern: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  tag: z.string().min(1),
}).strict();
const riskSuppressorDocumentSchema = z.object({
  if_all_match: z.array(z.string().min(1)).min(1),
  ceiling: z.number().int().min(0).max(100),
}).strict();
const riskSuppressorInputSchema = riskSuppressorDocumentSchema.transform((suppressor) => ({
  ifAllMatch: suppressor.if_all_match,
  ceiling: suppressor.ceiling,
}));
const riskThresholdDocumentSchema = z.object({
  low: z.number().int().min(0).max(100).optional(),
  high: z.number().int().min(0).max(100).optional(),
}).strict();
const riskThresholdInputSchema = z.object({
  low: z.number().int().min(0).max(100).default(25),
  high: z.number().int().min(0).max(100).default(70),
}).strict().default({});
const riskSizeDocumentSchema = z.object({
  high_changed_files: z.number().int().positive().optional(),
  high_changed_lines: z.number().int().positive().optional(),
}).strict();
const riskSizeInputSchema = z.object({
  high_changed_files: z.number().int().positive().default(100),
  high_changed_lines: z.number().int().positive().default(5000),
}).strict().default({}).transform((size) => ({
  highChangedFiles: size.high_changed_files,
  highChangedLines: size.high_changed_lines,
}));
const riskAiAuthorshipDocumentSchema = z.object({
  enabled: z.boolean().optional(),
  modifier: z.number().int().min(0).max(100).optional(),
}).strict();
const riskAiAuthorshipInputSchema = z.object({
  enabled: z.boolean().default(true),
  modifier: z.number().int().min(0).max(100).default(10),
}).strict().default({});
const riskDocumentSchema = z.object({
  size: riskSizeDocumentSchema.optional(),
  thresholds: riskThresholdDocumentSchema.optional(),
  paths: z.array(riskPathSchema).optional(),
  suppressors: z.array(riskSuppressorDocumentSchema).optional(),
  ai_authorship: riskAiAuthorshipDocumentSchema.optional(),
}).strict();
const riskInputSchema = z.object({
  size: riskSizeInputSchema,
  thresholds: riskThresholdInputSchema,
  paths: z.array(riskPathSchema).default([]),
  suppressors: z.array(riskSuppressorInputSchema).default([]),
  ai_authorship: riskAiAuthorshipInputSchema,
}).strict().default({}).transform((risk) => ({
  size: risk.size,
  thresholds: risk.thresholds,
  paths: risk.paths,
  suppressors: risk.suppressors,
  aiAuthorship: risk.ai_authorship,
}));

const ownershipRuleInputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  reviewers: z.array(reviewerHandleSchema).min(1),
}).strict();
const ownershipDocumentSchema = z.object({
  rules: z.array(ownershipRuleInputSchema).optional(),
  fallback_reviewers: z.array(reviewerHandleSchema).optional(),
}).strict();
const ownershipInputSchema = z.object({
  rules: z.array(ownershipRuleInputSchema).default([]),
  fallback_reviewers: z.array(reviewerHandleSchema).default([]),
}).strict().default({}).transform((ownership) => ({
  rules: ownership.rules,
  fallbackReviewers: ownership.fallback_reviewers,
}));

const partialConfigurationDocumentSchema = z.object({
  version: z.literal(1).optional(),
  mode: repositoryModeSchema.optional(),
  routing: routingDocumentSchema.optional(),
  risk: riskDocumentSchema.optional(),
  ownership: ownershipDocumentSchema.optional(),
  inheritance: z.boolean().optional(),
}).strict().superRefine((document, context) => {
  checkKeyedDuplicates(document.risk?.paths, (entry) => normalizeScalar(entry.pattern), ["risk", "paths"], "pattern", context);
  checkKeyedDuplicates(document.risk?.suppressors, (entry) => normalizeSet(entry.if_all_match), ["risk", "suppressors"], "if_all_match", context);
  checkKeyedDuplicates(document.ownership?.rules, (entry) => normalizeSet(entry.paths), ["ownership", "rules"], "paths", context);
});

export const triagePilotConfigInputSchema = z.object({
  version: z.literal(1).default(1),
  mode: repositoryModeSchema.default("shadow"),
  routing: routingInputSchema,
  risk: riskInputSchema,
  ownership: ownershipInputSchema,
}).strict();

export type TriagePilotConfig = z.infer<typeof triagePilotConfigInputSchema>;

export function parseConfigurationDocument(source: string, options: { partial: boolean }): ConfigDocumentResult {
  const yamlResult = parseYaml(source);
  if (!yamlResult.ok) return yamlResult;
  const documentResult = partialConfigurationDocumentSchema.safeParse(yamlResult.value);
  if (!documentResult.success) return zodFailure(documentResult.error.issues);

  if (!options.partial) {
    const { inheritance: _inheritance, ...executionInput } = documentResult.data;
    const finalResult = triagePilotConfigInputSchema.safeParse(executionInput);
    if (!finalResult.success) return zodFailure(finalResult.error.issues);
  }

  return { ok: true, document: documentResult.data as ConfigurationDocumentValue, diagnostics: [] };
}

export function validateFinalConfiguration(input: unknown): ConfigParseResult {
  const result = triagePilotConfigInputSchema.safeParse(input);
  if (!result.success) return zodFailure(result.error.issues);
  return { ok: true, config: result.data, diagnostics: [] };
}

export function parseTriagePilotConfig(source: string): ConfigParseResult {
  const yamlResult = parseYaml(source);
  if (!yamlResult.ok) return yamlResult;
  return validateFinalConfiguration(yamlResult.value);
}

function parseYaml(source: string): { ok: true; value: unknown } | { ok: false; diagnostics: ConfigDiagnostic[] } {
  try {
    return { ok: true, value: parse(source) ?? {} };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ path: "$", message: error instanceof Error ? error.message : "invalid YAML" }],
    };
  }
}

function checkKeyedDuplicates<T>(
  entries: T[] | undefined,
  keyFor: (entry: T) => string,
  path: Array<string | number>,
  keyField: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries?.forEach((entry, index) => {
    const key = keyFor(entry);
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, keyField],
        message: `duplicate ${keyField} key`,
      });
    }
    seen.add(key);
  });
}

function normalizeScalar(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSet(values: string[]): string {
  return values.map(normalizeScalar).sort().join("\u0000");
}

function zodFailure(issues: z.ZodIssue[]): { ok: false; diagnostics: ConfigDiagnostic[] } {
  return {
    ok: false,
    diagnostics: issues.map((issue) => ({ path: formatDiagnosticPath(issue.path), message: issue.message })),
  };
}

export function formatDiagnosticPath(path: Array<string | number>): string {
  return path.reduce<string>((formatted, segment) => (
    typeof segment === "number" ? `${formatted}[${segment}]` : `${formatted}.${segment}`
  ), "$" );
}
