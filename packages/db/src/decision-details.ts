import type { BranchExclusion } from "@triagepilot/contracts";

/** Read only the public exclusion fields from the internal decision snapshot. */
export function readBranchExclusion(details: unknown): BranchExclusion | undefined {
  if (typeof details !== "object" || details === null || !("branchExclusion" in details)) return undefined;
  const value = details.branchExclusion;
  if (typeof value !== "object" || value === null
    || !("type" in value) || (value.type !== "target_branch" && value.type !== "source_branch")
    || !("branch" in value) || typeof value.branch !== "string"
    || !("matchingRule" in value) || typeof value.matchingRule !== "string") return undefined;
  return { type: value.type, branch: value.branch, matchingRule: value.matchingRule };
}
