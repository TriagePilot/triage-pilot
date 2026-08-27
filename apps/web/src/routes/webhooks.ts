import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  buildRoutingKey,
  type HumanReviewPolicyJobPayload,
  type NormalizedChangeRequestEvent,
  type RoutingJobPayload,
} from "@triagepilot/contracts";
import type { GitHubWebhookInput } from "@triagepilot/provider-github";
import type {
  GitHubInstallationMetadata,
  GitHubId,
  GitHubRepositoryMetadata,
} from "@triagepilot/shared";

const SELF_HOSTED_WORKSPACE_ID = "ws_local";

const githubIdSchema = z.number().int().safe().transform((id) => String(id));
const accountSchema = z.object({ login: z.string(), type: z.string() });
const repositorySchema = z.object({ id: githubIdSchema, name: z.string() });

const repositoryOwnerSchema = z.object({ repository: z.object({ owner: accountSchema }) });

const installationWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({ id: githubIdSchema, account: accountSchema }),
  repositories: z.array(repositorySchema).optional(),
});

const installationRepositoriesWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({ id: githubIdSchema, account: accountSchema }),
  repositories_added: z.array(repositorySchema).default([]),
  repositories_removed: z.array(repositorySchema).default([]),
});

interface IgnoredWebhookMetadata {
  eventName: string;
  deliveryId: string;
  accountType: string;
  accountLogin: string;
}

export interface WebhookServices {
  githubOrganization: string;
  getWebhookSecret(): Promise<string>;
  verifySignature(input: { body: string; secret: string; signature: string | null }): Promise<void>;
  normalizeGitHubWebhook(input: GitHubWebhookInput): NormalizedChangeRequestEvent | null;
  acceptRoutingDelivery(input: {
    deliveryId: string;
    eventName: string;
    eventAction: string;
    hookId: string | null;
    installation: GitHubInstallationMetadata;
    repository: GitHubRepositoryMetadata;
    payload: RoutingJobPayload;
  }): Promise<{ inserted: boolean; jobId: string | null }>;
  acceptHumanReviewPolicyDelivery(input: {
    deliveryId: string;
    eventName: string;
    eventAction?: string;
    hookId?: string | null;
    installation: GitHubInstallationMetadata;
    repository: GitHubRepositoryMetadata;
    payload: HumanReviewPolicyJobPayload;
  }): Promise<{ inserted: boolean; jobId: string | null }>;
  activateConfiguredInstallation(input: GitHubInstallationMetadata): Promise<void>;
  replaceInstallationRepositories(input: {
    githubInstallationId: GitHubId;
    accountLogin: string;
    repositories: GitHubRepositoryMetadata[];
  }): Promise<void>;
  updateInstallationRepositories(input: {
    githubInstallationId: GitHubId;
    accountLogin: string;
    repositoriesAdded: GitHubRepositoryMetadata[];
    repositoryIdsRemoved: GitHubId[];
  }): Promise<void>;
  suspendConfiguredInstallation(input: GitHubInstallationMetadata): Promise<void>;
  deleteConfiguredInstallation(input: Pick<GitHubInstallationMetadata, "githubInstallationId">): Promise<void>;
  logIgnoredWebhook(input: IgnoredWebhookMetadata): void;
}

export function githubWebhookRoutes(services: WebhookServices) {
  const app = new Hono();

  app.post("/github", async (c) => {
    const body = await c.req.text();
    const eventName = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";

    const secret = await services.getWebhookSecret();
    await services.verifySignature({
      body,
      secret,
      signature: c.req.header("x-hub-signature-256") ?? null,
    });

    if (!deliveryId) return c.json({ error: "missing delivery id" }, 400);
    if (!isSupportedEvent(eventName)) {
      return c.json({ ok: true, ignored: "event" as const }, 202);
    }

    const parsedBody = body ? (JSON.parse(body) as unknown) : {};

    if (eventName === "pull_request" || eventName === "pull_request_review") {
      const account = repositoryOwnerSchema.parse(parsedBody).repository.owner;
      if (!isConfiguredOrganization(account, services.githubOrganization)) {
        return ignoreAccount(c, services, eventName, deliveryId, account);
      }
      const normalized = services.normalizeGitHubWebhook({ eventName, deliveryId, payload: parsedBody });
      if (normalized === null) {
        return c.json({ ok: true, ignored: "action" as const }, 202);
      }

      if (normalized.eventName === "change_request") {
        const routingPayload: RoutingJobPayload = {
          kind: "process_change_request",
          deliveryId,
          eventName: `${normalized.eventName}.${normalized.eventAction}`,
          workspaceId: SELF_HOSTED_WORKSPACE_ID,
          providerConnectionId: normalized.externalConnectionId,
          changeRequest: normalized.changeRequest,
          isDraft: normalized.isDraft,
          routingKey: buildRoutingKey({
            workspaceId: SELF_HOSTED_WORKSPACE_ID,
            provider: normalized.provider,
            repositoryId: normalized.changeRequest.repository.externalId,
            changeRequestId: normalized.changeRequest.externalId,
            trustedConfigRevision: normalized.changeRequest.baseRevision,
            headRevision: normalized.changeRequest.headRevision,
          }),
        };
        const accepted = await services.acceptRoutingDelivery({
          deliveryId,
          eventName,
          eventAction: normalized.eventAction,
          hookId: c.req.header("x-github-hook-id") ?? null,
          installation: toInstallationMetadata(normalized),
          repository: toRepositoryMetadata(normalized),
          payload: routingPayload,
        });
        return accepted.inserted
          ? c.json({ ok: true }, 202)
          : c.json({ ok: true, duplicate: true as const }, 202);
      }

      const reviewPolicyPayload: HumanReviewPolicyJobPayload = {
        kind: "evaluate_human_review_policy",
        deliveryId,
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        providerConnectionId: normalized.externalConnectionId,
        changeRequest: {
          repository: normalized.changeRequest.repository,
          externalId: normalized.changeRequest.externalId,
          number: normalized.changeRequest.number,
        },
      };
      const accepted = await services.acceptHumanReviewPolicyDelivery({
        deliveryId,
        eventName,
        eventAction: normalized.eventAction,
        hookId: c.req.header("x-github-hook-id") ?? null,
        installation: toInstallationMetadata(normalized),
        repository: toRepositoryMetadata(normalized),
        payload: reviewPolicyPayload,
      });
      return accepted.inserted
        ? c.json({ ok: true }, 202)
        : c.json({ ok: true, duplicate: true as const }, 202);
    }

    if (eventName === "installation") {
      const payload = installationWebhookSchema.parse(parsedBody);
      const account = payload.installation.account;
      if (!isConfiguredOrganization(account, services.githubOrganization)) {
        return ignoreAccount(c, services, eventName, deliveryId, account);
      }

      const installation = {
        githubInstallationId: payload.installation.id,
        accountLogin: account.login,
      };
      if (["created", "new_permissions_accepted", "unsuspend"].includes(payload.action)) {
        if (payload.repositories) {
          await services.replaceInstallationRepositories({
            ...installation,
            repositories: toRepositories(payload.repositories, account.login),
          });
        } else {
          await services.activateConfiguredInstallation(installation);
        }
        return c.json({ ok: true }, 202);
      }
      if (payload.action === "suspend") {
        await services.suspendConfiguredInstallation(installation);
        return c.json({ ok: true }, 202);
      }
      if (payload.action === "deleted") {
        await services.deleteConfiguredInstallation({
          githubInstallationId: payload.installation.id,
        });
        return c.json({ ok: true }, 202);
      }
      return c.json({ ok: true, ignored: "event" as const }, 202);
    }

    const payload = installationRepositoriesWebhookSchema.parse(parsedBody);
    const account = payload.installation.account;
    if (!isConfiguredOrganization(account, services.githubOrganization)) {
      return ignoreAccount(c, services, eventName, deliveryId, account);
    }
    if (payload.action !== "added" && payload.action !== "removed") {
      return c.json({ ok: true, ignored: "event" as const }, 202);
    }
    await services.updateInstallationRepositories({
      githubInstallationId: payload.installation.id,
      accountLogin: account.login,
      repositoriesAdded:
        payload.action === "added" ? toRepositories(payload.repositories_added, account.login) : [],
      repositoryIdsRemoved:
        payload.action === "removed" ? payload.repositories_removed.map((repository) => repository.id) : [],
    });
    return c.json({ ok: true }, 202);
  });

  return app;
}

function toInstallationMetadata(event: NormalizedChangeRequestEvent): GitHubInstallationMetadata {
  return {
    githubInstallationId: event.externalConnectionId,
    accountLogin: event.changeRequest.repository.owner,
  };
}

function toRepositoryMetadata(event: NormalizedChangeRequestEvent): GitHubRepositoryMetadata {
  return {
    githubRepositoryId: event.changeRequest.repository.externalId,
    owner: event.changeRequest.repository.owner,
    name: event.changeRequest.repository.name,
  };
}

function isSupportedEvent(
  eventName: string,
): eventName is "pull_request" | "pull_request_review" | "installation" | "installation_repositories" {
  return ["pull_request", "pull_request_review", "installation", "installation_repositories"].includes(eventName);
}

function isConfiguredOrganization(account: z.infer<typeof accountSchema>, configuredLogin: string): boolean {
  return account.type === "Organization" && account.login.toLowerCase() === configuredLogin.toLowerCase();
}

function ignoreAccount(
  c: Context,
  services: WebhookServices,
  eventName: string,
  deliveryId: string,
  account: z.infer<typeof accountSchema>,
) {
  services.logIgnoredWebhook({
    eventName,
    deliveryId,
    accountType: account.type,
    accountLogin: account.login,
  });
  return c.json({ ok: true, ignored: "account_scope" as const }, 202);
}

function toRepositories(
  repositories: z.infer<typeof repositorySchema>[],
  owner: string,
): GitHubRepositoryMetadata[] {
  return repositories.map((repository) => ({
    githubRepositoryId: repository.id,
    owner,
    name: repository.name,
  }));
}
