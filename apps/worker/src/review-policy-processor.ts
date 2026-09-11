import { evaluateReviewPolicy, type ReviewPolicyApplicationPorts } from "@triagepilot/application";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/contracts";

export interface HumanReviewPolicyServices extends ReviewPolicyApplicationPorts {
  failPolicyCheck?(summary: string, decisionId?: string): Promise<void>;
  policyCheckFailureDecisionId?(): string | null;
}

export async function processHumanReviewPolicyJob(
  message: HumanReviewPolicyJobPayload,
  services: HumanReviewPolicyServices,
): Promise<void> {
  await evaluateReviewPolicy(message, services);
}
