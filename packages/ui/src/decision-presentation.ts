import type { BranchExclusion } from "@triagepilot/contracts";

export const IGNORED_RISK_DESCRIPTION = "Ignored — risk not evaluated";

export function describeBranchExclusion(exclusion: BranchExclusion): string {
  return `${exclusion.type === "target_branch" ? "Target" : "Source"} branch "${exclusion.branch}" matches "${exclusion.matchingRule}".`;
}
