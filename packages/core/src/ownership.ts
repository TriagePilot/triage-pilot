import { minimatch } from "minimatch";

export interface OwnershipRule {
  paths: string[];
  reviewers: string[];
}

export interface OwnershipInput {
  files: string[];
  rules: OwnershipRule[];
  fallbackReviewers: string[];
}

export interface OwnershipMatchResult {
  matchedRules: Array<{
    pattern: string;
    reviewers: string[];
    matchedFiles: string[];
  }>;
  preferredReviewers: string[];
  eligibleReviewers: string[];
  uncoveredFiles: string[];
  usedFallback: boolean;
}

export function matchOwnership(input: OwnershipInput): OwnershipMatchResult {
  const matchedRules = input.rules
    .flatMap((rule) => rule.paths.map((pattern) => ({
      pattern,
      reviewers: rule.reviewers,
      matchedFiles: input.files.filter((file) => minimatch(file, pattern, { dot: true, matchBase: true })),
    })))
    .filter((rule) => rule.matchedFiles.length > 0);

  const matchedFiles = new Set(matchedRules.flatMap((rule) => rule.matchedFiles));
  const matchedReviewers = dedupe(matchedRules.flatMap((rule) => rule.reviewers));
  const usedFallback = matchedReviewers.length === 0;
  const preferredReviewers = usedFallback ? dedupe(input.fallbackReviewers) : matchedReviewers;

  return {
    matchedRules,
    preferredReviewers,
    eligibleReviewers: dedupe([...preferredReviewers, ...input.fallbackReviewers]),
    uncoveredFiles: input.files.filter((file) => !matchedFiles.has(file)),
    usedFallback,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
