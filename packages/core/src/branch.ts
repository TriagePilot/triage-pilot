import { minimatch } from "minimatch";

export function isBranchExcluded(branch: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(branch, pattern, { dot: true }));
}
