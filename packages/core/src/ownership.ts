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
    index: number;
    paths: string[];
    reviewers: string[];
    matchedFiles: string[];
  }>;
  eligibleReviewers: string[];
  uncoveredFiles: string[];
  usedFallback: boolean;
}

export function matchOwnership(input: OwnershipInput): OwnershipMatchResult {
  const matchedRules = input.rules
    .map((rule, index) => ({
      index,
      paths: rule.paths,
      reviewers: rule.reviewers,
      matchedFiles: input.files.filter((file) => rule.paths.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: true }))),
    }))
    .filter((rule) => rule.matchedFiles.length > 0);

  const matchedFiles = new Set(matchedRules.flatMap((rule) => rule.matchedFiles));
  const directReviewers = dedupe(matchedRules.flatMap((rule) => rule.reviewers));
  const usedFallback = directReviewers.length === 0;

  return {
    matchedRules,
    eligibleReviewers: usedFallback ? dedupe(input.fallbackReviewers) : directReviewers,
    uncoveredFiles: input.files.filter((file) => !matchedFiles.has(file)),
    usedFallback,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
