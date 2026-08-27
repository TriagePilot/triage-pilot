import {
  createWorkspaceRepositories,
  type createDatabase,
  type WorkspaceRepositories,
} from "@triagepilot/db";
import type { WorkspaceId } from "@triagepilot/contracts";
import type { GitHubAppCredentialShape } from "@triagepilot/provider-github";
import { formatLog } from "@triagepilot/shared";
import { sql } from "kysely";

import type { WebServices } from "./app";

interface WebRuntimeServicesInput {
  db: ReturnType<typeof createDatabase>;
  workspaceId: WorkspaceId;
  repositories?: WorkspaceRepositories;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  secureCookies: boolean;
  now: WebServices["now"];
  sourceAddress: WebServices["sourceAddress"];
  githubOrganization: string;
  github: GitHubAppCredentialShape;
  verifySignature: WebServices["verifySignature"];
  normalizeGitHubWebhook: WebServices["normalizeGitHubWebhook"];
}

export function createWebRuntimeServices(input: WebRuntimeServicesInput): WebServices {
  const repositories = input.repositories ?? createWorkspaceRepositories(input.db, input.workspaceId);
  return {
    adminUsername: input.adminUsername,
    adminPassword: input.adminPassword,
    sessionSecret: input.sessionSecret,
    secureCookies: input.secureCookies,
    now: input.now,
    sourceAddress: input.sourceAddress,
    githubOrganization: input.githubOrganization,
    workspaceId: input.workspaceId,
    verifySignature: input.verifySignature,
    normalizeGitHubWebhook: input.normalizeGitHubWebhook,

    async checkDatabase() {
      await sql`select 1`.execute(input.db);
    },

    async getWebhookSecret() {
      return input.github.webhookSecret;
    },

    async acceptRoutingDelivery(delivery) {
      const { installation, repository, ...inputDelivery } = delivery;
      return await repositories.acceptRoutingDelivery({
        ...inputDelivery,
        connection: toProviderConnection(installation),
        repository: toProviderRepository(repository),
      });
    },

    async acceptHumanReviewPolicyDelivery(delivery) {
      const { installation, repository, ...inputDelivery } = delivery;
      return await repositories.acceptHumanReviewPolicyDelivery({
        ...inputDelivery,
        connection: toProviderConnection(installation),
        repository: toProviderRepository(repository),
      });
    },

    async activateConfiguredInstallation(installation) {
      await repositories.activateConfiguredProviderConnection(toProviderConnection(installation));
    },

    async replaceInstallationRepositories(installation) {
      await repositories.replaceProviderConnectionRepositories({
        ...toProviderConnection(installation),
        repositories: installation.repositories.map(toProviderRepository),
      });
    },

    async updateInstallationRepositories(installation) {
      await repositories.updateProviderConnectionRepositories({
        ...toProviderConnection(installation),
        repositoriesAdded: installation.repositoriesAdded.map(toProviderRepository),
        repositoryIdsRemoved: installation.repositoryIdsRemoved,
      });
    },

    async suspendConfiguredInstallation(installation) {
      await repositories.suspendConfiguredProviderConnection(toProviderConnection(installation));
    },

    async deleteConfiguredInstallation(installation) {
      await repositories.deleteConfiguredProviderConnection({
        provider: "github",
        externalConnectionId: installation.githubInstallationId,
      });
    },

    logIgnoredWebhook(metadata) {
      console.warn(formatLog({
        level: "warn",
        event: "ignored_out_of_scope_github_webhook",
        service: "web",
        workspaceId: input.workspaceId,
        provider: "github",
        deliveryId: metadata.deliveryId,
        providerAccountType: metadata.accountType,
        providerAccountLogin: metadata.accountLogin,
      }));
    },

    async listOperationsOverview() {
      return await repositories.readOperations({
        githubOrganization: input.githubOrganization,
        githubAppId: input.github.appId,
        now: input.now(),
        heartbeatStaleAfterMs: 30_000,
      });
    },
  };
}

function toProviderConnection(input: { githubInstallationId: string; accountLogin?: string }) {
  return {
    provider: "github" as const,
    externalConnectionId: input.githubInstallationId,
    workspaceLogin: input.accountLogin ?? "",
    accountType: "Organization",
  };
}

function toProviderRepository(input: { githubRepositoryId: string; owner: string; name: string }) {
  return {
    provider: "github" as const,
    externalRepositoryId: input.githubRepositoryId,
    owner: input.owner,
    name: input.name,
  };
}
