import type { NormalizedChangeRequestEvent, QueueInvalidationRef } from "@triagepilot/contracts";
import { z } from "zod";

const ROUTING_PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const REVIEW_PULL_REQUEST_ACTIONS = new Set(["submitted", "edited", "dismissed"]);

const githubIdSchema = z.union([
  z.number().int().safe().transform(String),
  z.string().trim().regex(/^\d+$/),
]);

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({ id: githubIdSchema }),
  sender: z.object({
    id: githubIdSchema,
    login: z.string().trim().min(1),
  }),
  repository: z.object({
    id: githubIdSchema,
    name: z.string().trim().min(1),
    owner: z.object({ login: z.string().trim().min(1), type: z.string().trim().min(1) }),
  }),
  pull_request: z.object({
    id: githubIdSchema,
    number: z.number().int().positive(),
    draft: z.boolean(),
    base: z.object({ sha: z.string().trim().min(1) }),
    head: z.object({ sha: z.string().trim().min(1) }),
  }),
});

const pullRequestReviewWebhookSchema = pullRequestWebhookSchema.extend({
  review: z.object({ state: z.string().trim().min(1) }),
});

export interface GitHubWebhookInput {
  deliveryId: string;
  eventName: string;
  payload: unknown;
}

export interface NormalizedGitHubWebhookEvent extends NormalizedChangeRequestEvent {
  provider: "github";
  providerAccount: { login: string; type: string };
}

export function normalizeGitHubWebhook(input: GitHubWebhookInput): NormalizedGitHubWebhookEvent | null {
  if (input.eventName === "pull_request") {
    const payload = pullRequestWebhookSchema.parse(input.payload);
    if (!ROUTING_PULL_REQUEST_ACTIONS.has(payload.action)) return null;
    return toNormalizedEvent(input.deliveryId, "change_request", payload);
  }

  if (input.eventName === "pull_request_review") {
    const payload = pullRequestReviewWebhookSchema.parse(input.payload);
    if (!REVIEW_PULL_REQUEST_ACTIONS.has(payload.action)) return null;
    return toNormalizedEvent(input.deliveryId, "change_request_review", payload);
  }

  return null;
}

function toNormalizedEvent(
  deliveryId: string,
  eventName: NormalizedChangeRequestEvent["eventName"],
  payload: z.infer<typeof pullRequestWebhookSchema>,
): NormalizedGitHubWebhookEvent {
  return {
    deliveryId,
    eventName,
    eventAction: payload.action,
    provider: "github",
    externalConnectionId: payload.installation.id,
    providerAccount: {
      login: payload.repository.owner.login,
      type: payload.repository.owner.type,
    },
    changeRequest: {
      repository: {
        provider: "github",
        externalId: payload.repository.id,
        owner: payload.repository.owner.login,
        name: payload.repository.name,
      },
      externalId: String(payload.pull_request.number),
      number: payload.pull_request.number,
      baseRevision: payload.pull_request.base.sha,
      headRevision: payload.pull_request.head.sha,
    },
    actor: {
      externalId: payload.sender.id,
      displayName: payload.sender.login,
    },
    isDraft: payload.pull_request.draft,
  };
}

const INVALIDATION_PULL_ACTIONS = new Set(["opened", "reopened", "synchronize", "closed", "edited", "ready_for_review", "converted_to_draft", "review_requested", "review_request_removed"]);

export function normalizeQueueInvalidation(eventName: string, payload: unknown): QueueInvalidationRef | null {
  if (eventName !== "pull_request" && eventName !== "pull_request_review") return null;
  const parsed = (eventName === "pull_request_review" ? pullRequestReviewWebhookSchema : pullRequestWebhookSchema).parse(payload);
  if (!(eventName === "pull_request" ? INVALIDATION_PULL_ACTIONS : REVIEW_PULL_REQUEST_ACTIONS).has(parsed.action)) return null;
  return { externalInstallationId: parsed.installation.id, repository: { provider: "github", externalId: parsed.repository.id, owner: parsed.repository.owner.login, name: parsed.repository.name }, pullNumber: parsed.pull_request.number };
}
