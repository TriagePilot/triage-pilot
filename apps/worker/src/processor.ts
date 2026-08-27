import { processChangeRequest, type RoutingApplicationPorts } from "@triagepilot/application";
import type { RoutingJobPayload } from "@triagepilot/contracts";

export type RoutingJobMessage = RoutingJobPayload;

export interface RoutingJobServices extends RoutingApplicationPorts {
  failPolicyCheck?(summary: string): Promise<void>;
}

export async function processRoutingJob(
  message: RoutingJobMessage,
  services: RoutingJobServices,
): Promise<void> {
  await processChangeRequest(message, services);
}
