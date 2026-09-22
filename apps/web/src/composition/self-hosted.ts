import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  RoutingRecoveryTargetUnavailableError,
  RoutingRecoveryValidationError,
  queueRoutingRecovery,
  type RoutingRecoveryRequest,
} from "@triagepilot/application";
import { resolveConfiguration, type TriagePilotConfig } from "@triagepilot/config";
import type { ConfigurationDocument, ConfigurationSource, RepositoryRef, WorkspaceId } from "@triagepilot/contracts";
import {
  createDatabase,
  createWorkspaceRoutingRecoveryRepository,
  createWorkspaceRepositories,
  ensureLocalWorkspace,
  type WorkspaceRepositories,
} from "@triagepilot/db";
import type { EffectiveConfigurationOverview, EffectiveConfigurationValue } from "@triagepilot/ui";
import {
  createInstallationRequester,
  GitHubAdapter,
  GitHubConfigurationSource,
  GitHubCredentialProvider,
  githubRepositoryUrl,
  normalizeGitHubWebhook,
  parseGitHubPullRequestUrl,
  verifyGitHubSignature,
} from "@triagepilot/provider-github";

import type { WebServices } from "../app.js";
import type { WebRuntimeEnv } from "../runtime-env.js";
import { createWebRuntimeServices } from "../runtime-services.js";

type DatabaseClient = ReturnType<typeof createDatabase>;

export interface SelfHostedConfigurationProbeInput {
  repositoryDocument: string | null;
}

export interface SelfHostedConfigurationProbe {
  allowOrganizationEnforce: false;
  resolve(input: SelfHostedConfigurationProbeInput): ReturnType<typeof resolveConfiguration>;
}

export interface SelfHostedWebComposition {
  db: DatabaseClient;
  workspaceId: WorkspaceId;
  localRepositories: WorkspaceRepositories;
  services: WebServices;
  configuration: SelfHostedConfigurationProbe;
  routingRecovery: SelfHostedRoutingRecovery;
  close(): Promise<void>;
}

export interface SelfHostedWebCompositionDependencies {
  createRequester?: typeof createInstallationRequester;
  createRunId?: () => string;
}

export type SelfHostedRoutingRecoveryRequest = { decisionId: string } | { changeRequestUrl: string };

export interface SelfHostedRoutingRecovery {
  queue(request: SelfHostedRoutingRecoveryRequest): Promise<{ jobId: string; routingKey: string }>;
}

export async function createSelfHostedWebComposition(
  env: WebRuntimeEnv,
  dependencies: SelfHostedWebCompositionDependencies = {},
): Promise<SelfHostedWebComposition> {
  const db = createDatabase(env.databaseUrl);
  const workspaceId = await ensureLocalWorkspace(db);
  const localRepositories = createWorkspaceRepositories(db, workspaceId);
  const configuration = createSelfHostedConfigurationProbe(workspaceId);
  const routingRecovery = createSelfHostedRoutingRecovery({
    db,
    workspaceId,
    github: env.github,
    ...(dependencies.createRequester === undefined ? {} : { createRequester: dependencies.createRequester }),
    ...(dependencies.createRunId === undefined ? {} : { createRunId: dependencies.createRunId }),
  });
  const services = createWebRuntimeServices({
    db,
    workspaceId,
    repositories: localRepositories,
    adminUsername: env.adminUsername,
    adminPassword: env.adminPassword,
    sessionSecret: env.sessionSecret,
    secureCookies: env.secureCookies,
    now: () => new Date(),
    sourceAddress: (c) => getConnInfo(c).remote.address ?? "unknown",
    githubOrganization: env.githubOrganization,
    github: env.github,
    verifySignature: verifyGitHubSignature,
    normalizeGitHubWebhook,
    readEffectiveConfiguration: (repositoryId) => readSelfHostedEffectiveConfiguration({
      workspaceId,
      repositoryId,
      repositories: localRepositories,
      github: env.github,
      ...(dependencies.createRequester === undefined ? {} : { createRequester: dependencies.createRequester }),
    }),
    queueRoutingRecovery: (request) => routingRecovery.queue(request),
  });

  return {
    db,
    workspaceId,
    localRepositories,
    services,
    configuration,
    routingRecovery,
    close: () => db.destroy(),
  };
}

export function createSelfHostedRoutingRecovery(input: {
  db: DatabaseClient;
  workspaceId: WorkspaceId;
  github: WebRuntimeEnv["github"];
  createRequester?: typeof createInstallationRequester;
  createRunId?: () => string;
}): SelfHostedRoutingRecovery {
  const repository = createWorkspaceRoutingRecoveryRepository(input.db, input.workspaceId);
  const credentialProvider = new GitHubCredentialProvider(input.github);
  const createRequester = input.createRequester ?? createInstallationRequester;
  const createRunId = input.createRunId ?? randomUUID;

  return {
    async queue(request) {
      const applicationRequest = await toRoutingRecoveryRequest(request);
      return await queueRoutingRecovery({ workspaceId: input.workspaceId, request: applicationRequest }, {
        createRunId,
        findTarget: async (targetInput) => {
          if (targetInput.workspaceId !== input.workspaceId) return null;
          return await repository.findTarget(targetInput.request);
        },
        fetchCurrentState: async (target) => {
          if (target.workspaceId !== input.workspaceId || target.repository.provider !== "github") {
            throw new RoutingRecoveryTargetUnavailableError(
              "Routing recovery target is unavailable in this workspace",
            );
          }
          const externalConnectionId = await repository.findActiveExternalConnectionId({
            provider: target.repository.provider,
            providerConnectionId: target.providerConnectionId,
          });
          if (externalConnectionId === null) {
            throw new RoutingRecoveryTargetUnavailableError(
              "Routing recovery target is unavailable in this workspace",
            );
          }
          const credentials = await credentialProvider.getCredential({
            workspaceId: input.workspaceId,
            providerConnectionId: target.providerConnectionId,
          });
          const requester = await createRequester({
            appId: credentials.appId,
            privateKey: credentials.privateKey,
            installationId: toSafeInteger(externalConnectionId),
          });
          return await new GitHubAdapter(requester).fetchRoutingRecoveryState({
            pullRequest: {
              owner: target.repository.owner,
              repo: target.repository.name,
              pullNumber: target.changeRequestNumber,
            },
          });
        },
        enqueue: async (enqueueInput) => {
          if (enqueueInput.workspaceId !== input.workspaceId) return null;
          return await repository.enqueue({
            provider: enqueueInput.provider,
            providerConnectionId: enqueueInput.providerConnectionId,
            payload: enqueueInput.payload,
            idempotencyKey: enqueueInput.idempotencyKey,
          });
        },
      });
    },
  };

  async function toRoutingRecoveryRequest(request: unknown): Promise<RoutingRecoveryRequest> {
    if (isRecord(request) && Object.keys(request).length === 1 && typeof request.changeRequestUrl === "string") {
      const parsed = parseGitHubPullRequestUrl(request.changeRequestUrl);
      if (parsed === null) throw new RoutingRecoveryValidationError("Enter a valid GitHub pull request URL");
      const activeRepository = await repository.findActiveRepository({
        provider: "github",
        owner: parsed.owner,
        name: parsed.repo,
      });
      if (activeRepository === null) {
        throw new RoutingRecoveryTargetUnavailableError("Routing recovery target is unavailable in this workspace");
      }
      return {
        changeRequest: {
          repository: activeRepository,
          externalId: String(parsed.pullNumber),
          number: parsed.pullNumber,
        },
      };
    }
    return request as RoutingRecoveryRequest;
  }
}

function createSelfHostedConfigurationProbe(workspaceId: WorkspaceId): SelfHostedConfigurationProbe {
  return {
    allowOrganizationEnforce: false,
    resolve(input) {
      return resolveConfiguration({
        workspaceId,
        repository: probeRepository(),
        trustedRevision: "self-hosted-probe",
        source: new ProbeConfigurationSource(input.repositoryDocument),
        allowOrganizationEnforce: false,
      });
    },
  };
}

function probeRepository(): RepositoryRef {
  return {
    provider: "github",
    externalId: "self-hosted-probe-repository",
    owner: "self-hosted",
    name: "probe",
  };
}

class ProbeConfigurationSource implements ConfigurationSource {
  constructor(private readonly repositoryDocument: string | null) {}

  async loadOrganization(_workspaceId: WorkspaceId): Promise<null> {
    return null;
  }

  async loadRepository(input: {
    workspaceId: WorkspaceId;
    repository: RepositoryRef;
    trustedRevision: string;
  }): Promise<ConfigurationDocument | null> {
    if (this.repositoryDocument === null) return null;
    return {
      content: this.repositoryDocument,
      revision: input.trustedRevision,
      path: ".triagepilot.yml",
    };
  }
}

export async function readSelfHostedEffectiveConfiguration(input: {
  workspaceId: WorkspaceId;
  repositoryId: string;
  repositories: Pick<WorkspaceRepositories, "findRepositoryConfigurationTarget">;
  github: WebRuntimeEnv["github"];
  createRequester?: typeof createInstallationRequester;
}): Promise<EffectiveConfigurationOverview> {
  const target = await input.repositories.findRepositoryConfigurationTarget(input.repositoryId);
  if (target === null) throw new Error("repository is unavailable in this workspace");
  if (target.repository.provider !== "github") {
    throw new Error(`unsupported self-hosted provider ${target.repository.provider}`);
  }

  const credentialProvider = new GitHubCredentialProvider(input.github);
  const credentials = await credentialProvider.getCredential({
    workspaceId: input.workspaceId,
    providerConnectionId: target.providerConnectionId,
  });
  const requester = await (input.createRequester ?? createInstallationRequester)({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId: toSafeInteger(target.externalConnectionId),
  });
  const trustedRevision = await new GitHubAdapter(requester).fetchDefaultBranchRevision(target.repository);
  const result = await resolveConfiguration({
    workspaceId: input.workspaceId,
    repository: target.repository,
    trustedRevision,
    source: new GitHubConfigurationSource(requester),
    allowOrganizationEnforce: false,
  });
  return {
    repository: {
      label: `${target.repository.owner}/${target.repository.name}`,
      href: githubRepositoryUrl(target.repository),
    },
    trustedPath: result.provenance.repositoryPath,
    trustedRevision,
    repositoryRevision: result.provenance.repositoryRevision,
    inheritanceMode: result.provenance.inheritanceMode,
    effectiveHash: result.provenance.effectiveHash,
    values: result.ok ? flattenConfigurationValues(result.config, result.provenance.sources) : [],
  };
}

function toSafeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid GitHub installation ID ${value}`);
  return number;
}

function flattenConfigurationValues(
  config: TriagePilotConfig,
  sources: Record<string, EffectiveConfigurationValue["source"]>,
): EffectiveConfigurationValue[] {
  return Object.entries(sources).map(([path, source]) => ({
    path,
    label: path.startsWith("$.") ? path.slice(2) : path,
    value: readPath(config, path),
    source,
  }));
}

function readPath(value: unknown, path: string): unknown {
  return path
    .replace(/^\$\./, "")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) return current[Number(segment)];
      if (isRecord(current)) return current[segment];
      return undefined;
    }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
