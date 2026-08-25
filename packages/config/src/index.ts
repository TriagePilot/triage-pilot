import { parse } from "yaml";
import { z } from "zod";

import type { RepositoryMode } from "@triagepilot/shared";

export interface ConfigDiagnostic {
  path: string;
  message: string;
}

export type ConfigParseResult =
  | { ok: true; config: TriagePilotConfig; diagnostics: [] }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

const reviewerHandleSchema = z.string().regex(/^@[A-Za-z0-9_.-]+$/, {
  message: "reviewer must be an individual GitHub user handle such as @sasha; teams are not supported",
});

const repositoryModeSchema: z.ZodType<RepositoryMode> = z.enum(["shadow", "enforce"]);

const routingInputSchema = z
  .object({
    high_risk_reviewers: z.union([z.literal(1), z.literal(2)]).default(1),
    exclude_target_branches: z.array(z.string().min(1)).default([]),
    exclude_source_branch_patterns: z.array(z.string().min(1)).default([]),
    include_draft_pull_requests: z.boolean().default(false),
  })
  .strict()
  .default({})
  .transform((routing) => ({
    highRiskReviewers: routing.high_risk_reviewers,
    excludeTargetBranches: routing.exclude_target_branches,
    excludeSourceBranchPatterns: routing.exclude_source_branch_patterns,
    includeDraftPullRequests: routing.include_draft_pull_requests,
  }));

const riskPathSchema = z
  .object({
    pattern: z.string().min(1),
    weight: z.number().int().min(0).max(100),
    tag: z.string().min(1),
  })
  .strict();

const riskSuppressorInputSchema = z
  .object({
    if_all_match: z.array(z.string().min(1)).min(1),
    ceiling: z.number().int().min(0).max(100),
  })
  .strict()
  .transform((suppressor) => ({
    ifAllMatch: suppressor.if_all_match,
    ceiling: suppressor.ceiling,
  }));

const riskThresholdInputSchema = z
  .object({
    low: z.number().int().min(0).max(100).default(25),
    high: z.number().int().min(0).max(100).default(70),
  })
  .strict()
  .default({});

const riskSizeInputSchema = z
  .object({
    high_changed_files: z.number().int().positive().default(100),
    high_changed_lines: z.number().int().positive().default(5000),
  })
  .strict()
  .default({})
  .transform((size) => ({
    highChangedFiles: size.high_changed_files,
    highChangedLines: size.high_changed_lines,
  }));

const riskAiAuthorshipInputSchema = z
  .object({
    enabled: z.boolean().default(true),
    modifier: z.number().int().min(0).max(100).default(10),
  })
  .strict()
  .default({});

const riskInputSchema = z
  .object({
    size: riskSizeInputSchema,
    thresholds: riskThresholdInputSchema,
    paths: z.array(riskPathSchema).default([]),
    suppressors: z.array(riskSuppressorInputSchema).default([]),
    ai_authorship: riskAiAuthorshipInputSchema,
  })
  .strict()
  .default({})
  .transform((risk) => ({
    size: risk.size,
    thresholds: risk.thresholds,
    paths: risk.paths,
    suppressors: risk.suppressors,
    aiAuthorship: risk.ai_authorship,
  }));

const ownershipRuleInputSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    reviewers: z.array(reviewerHandleSchema).min(1),
  })
  .strict();

const ownershipInputSchema = z
  .object({
    rules: z.array(ownershipRuleInputSchema).default([]),
    fallback_reviewers: z.array(reviewerHandleSchema).default([]),
  })
  .strict()
  .default({})
  .transform((ownership) => ({
    rules: ownership.rules,
    fallbackReviewers: ownership.fallback_reviewers,
  }));

const triagePilotConfigInputSchema = z
  .object({
    version: z.literal(1).default(1),
    mode: repositoryModeSchema.default("shadow"),
    routing: routingInputSchema,
    risk: riskInputSchema,
    ownership: ownershipInputSchema,
  })
  .strict();

export type TriagePilotConfig = z.infer<typeof triagePilotConfigInputSchema>;

export function parseTriagePilotConfig(source: string): ConfigParseResult {
  let parsed: unknown;

  try {
    parsed = parse(source);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          path: "$",
          message: error instanceof Error ? error.message : "invalid YAML",
        },
      ],
    };
  }

  const result = triagePilotConfigInputSchema.safeParse(parsed ?? {});

  if (!result.success) {
    return {
      ok: false,
      diagnostics: result.error.issues.map((issue) => ({
        path: formatDiagnosticPath(issue.path),
        message: issue.message,
      })),
    };
  }

  return { ok: true, config: result.data, diagnostics: [] };
}

function formatDiagnosticPath(path: Array<string | number>): string {
  if (path.length === 0) {
    return "$";
  }

  return `$.${path.join(".")}`;
}
