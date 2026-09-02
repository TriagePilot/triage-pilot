import {
  createWorkspaceReviewerAvailability,
  createWorkspaceRepositories,
  ProviderConnectionUnavailableError,
  type ReviewerAbsence,
  type ReviewerReplacement,
  type createDatabase,
  type OperationsOverview as DatabaseOperationsOverview,
  type WorkspaceRepositories,
} from "@triagepilot/db";
import type { EffectiveConfigurationOverview, OperationsOverview, ProviderLink } from "@triagepilot/ui";
import type { WorkspaceId } from "@triagepilot/contracts";
import {
  githubChangeRequestUrl,
  githubRepositoryUrl,
  type GitHubAppCredentialShape,
} from "@triagepilot/provider-github";
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
  readEffectiveConfiguration: (repositoryId: string) => Promise<EffectiveConfigurationOverview>;
}

export function createWebRuntimeServices(input: WebRuntimeServicesInput): WebServices {
  const repositories = input.repositories ?? createWorkspaceRepositories(input.db, input.workspaceId);
  const availability = createWorkspaceReviewerAvailability(input.db, input.workspaceId);

  async function activeAvailabilityScope() {
    const connections = await input.db
      .selectFrom("provider_connections")
      .select(["id", "provider"])
      .where("workspace_id", "=", input.workspaceId)
      .where("provider", "=", "github")
      .where("status", "=", "active")
      .limit(2)
      .execute();
    if (connections.length !== 1) {
      throw new ProviderConnectionUnavailableError("Provider connection is not active in this workspace");
    }
    return connections[0]!;
  }
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
      await repositories.revokeConfiguredProviderConnection({
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
      const overview = await repositories.readOperations({
        githubOrganization: input.githubOrganization,
        githubAppId: input.github.appId,
        now: input.now(),
        heartbeatStaleAfterMs: 30_000,
      });
      return toGitHubOperationsOverview(overview);
    },

    async readEffectiveConfiguration(repositoryId) {
      return await input.readEffectiveConfiguration(repositoryId);
    },

    async readAvailabilitySettings() {
      await activeAvailabilityScope();
      return toAvailabilitySettings(await availability.readSettings());
    },

    async updateAvailabilityTimezone({ timezone, now }) {
      await activeAvailabilityScope();
      return toAvailabilitySettings(await availability.updateTimezone(timezone, now));
    },

    async listReviewerAbsences() {
      const scope = await activeAvailabilityScope();
      const now = input.now();
      return (await availability.listAbsences())
        .filter((absence) => absence.provider === scope.provider && absence.providerConnectionId === scope.id)
        .map((absence) => toReviewerAbsenceOverview(absence, now));
    },

    async scheduleReviewerAbsence(availabilityInput) {
      const scope = await activeAvailabilityScope();
      return toReviewerAbsenceOverview(await availability.scheduleAbsence({
        ...availabilityInput,
        provider: scope.provider,
        providerConnectionId: scope.id,
      }), availabilityInput.now);
    },

    async reviseReviewerAbsence(availabilityInput) {
      const scope = await activeAvailabilityScope();
      return toReviewerAbsenceOverview(await availability.reviseAbsence({
        ...availabilityInput,
        provider: scope.provider,
        providerConnectionId: scope.id,
      }), availabilityInput.now);
    },

    async cancelReviewerAbsence(availabilityInput) {
      const scope = await activeAvailabilityScope();
      return toReviewerAbsenceOverview(await availability.cancelAbsence({
        ...availabilityInput,
        provider: scope.provider,
        providerConnectionId: scope.id,
      }), availabilityInput.now);
    },

    async listReviewerReplacementHistory(absenceId) {
      const scope = await activeAvailabilityScope();
      return (await availability.listReplacementHistory(absenceId))
        .filter((replacement) => replacement.provider === scope.provider && replacement.providerConnectionId === scope.id)
        .map(toReviewerReplacementOverview);
    },
  };
}

function toAvailabilitySettings(input: { timezone: string; updatedAt: Date }) {
  return { timezone: input.timezone, updatedAt: input.updatedAt.toISOString() };
}

function toReviewerAbsenceOverview(absence: ReviewerAbsence, now: Date) {
  const status = absence.status === "cancelled"
    ? "cancelled" as const
    : absence.endAt <= now
      ? "ended" as const
      : absence.startAt <= now
        ? "active" as const
        : "upcoming" as const;
  return {
    id: absence.id,
    externalActorId: absence.externalActorId,
    startAt: absence.startAt.toISOString(),
    endAt: absence.endAt.toISOString(),
    status,
    revision: absence.revision,
    cancelledAt: absence.cancelledAt?.toISOString() ?? null,
    createdAt: absence.createdAt.toISOString(),
    updatedAt: absence.updatedAt.toISOString(),
  };
}

function toReviewerReplacementOverview(replacement: ReviewerReplacement) {
  return {
    id: replacement.id,
    absenceId: replacement.absenceId,
    absenceRevision: replacement.absenceRevision,
    decisionId: replacement.decisionId,
    unavailableActorId: replacement.unavailableActorId,
    replacementActorId: replacement.replacementActorId,
    outcome: replacement.outcome,
    reason: replacement.reason,
    state: replacement.state,
    lastError: replacement.lastError,
    completedAt: replacement.completedAt.toISOString(),
  };
}

function toGitHubOperationsOverview(overview: DatabaseOperationsOverview): OperationsOverview {
  return {
    statuses: [
      { id: "workspace", label: "Organization", value: overview.organization },
      {
        id: "connection",
        label: "GitHub App",
        value: overview.githubApp.configured ? `App ${overview.githubApp.appId}` : "Not configured",
        detail: overview.githubApp.installationId
          ? `Installation ${overview.githubApp.installationId}`
          : "No active installation",
      },
    ],
    repositories: overview.repositories.map((repository) => ({
      id: repository.id,
      repository: githubLink(repository.owner, repository.name),
      configState: repository.configState,
      mode: repository.mode,
    })),
    decisions: overview.decisions.map((decision) => {
      const { pullNumber, ...providerNeutralDecision } = decision;
      const repository = githubLinkFromName(decision.repository);
      return {
        ...providerNeutralDecision,
        repository,
        changeRequest: pullNumber === null
          ? null
          : {
              label: `#${pullNumber}`,
              href: githubChangeRequestUrl(repositoryRefFromName(decision.repository), pullNumber),
            },
      };
    }),
    failures: {
      jobs: overview.failures.jobs,
      actions: overview.failures.actions.map((failure) => ({
        ...failure,
        repository: githubLinkFromName(failure.repository),
      })),
    },
    worker: overview.worker,
  };
}

function githubLink(owner: string, name: string): ProviderLink {
  const repository = { owner, name };
  return { label: `${owner}/${name}`, href: githubRepositoryUrl(repository) };
}

function githubLinkFromName(name: string): ProviderLink {
  const repository = repositoryRefFromName(name);
  return { label: name, href: githubRepositoryUrl(repository) };
}

function repositoryRefFromName(name: string): { owner: string; name: string } {
  const separator = name.indexOf("/");
  if (separator <= 0 || separator === name.length - 1) {
    return { owner: "", name };
  }
  return { owner: name.slice(0, separator), name: name.slice(separator + 1) };
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
