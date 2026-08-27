import { getConnInfo } from "@hono/node-server/conninfo";
import { resolveConfiguration, type TriagePilotConfig } from "@triagepilot/config";
import type { ConfigurationDocument, ConfigurationSource, RepositoryRef, WorkspaceId } from "@triagepilot/contracts";
import {
  createDatabase,
  createWorkspaceRepositories,
  ensureLocalWorkspace,
  type WorkspaceRepositories,
} from "@triagepilot/db";
import type { EffectiveConfigurationOverview, EffectiveConfigurationValue } from "@triagepilot/ui";
import {
  normalizeGitHubWebhook,
  verifyGitHubSignature,
} from "@triagepilot/provider-github";

import type { WebServices } from "../app";
import type { WebRuntimeEnv } from "../runtime-env";
import { createWebRuntimeServices } from "../runtime-services";

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
  close(): Promise<void>;
}

export async function createSelfHostedWebComposition(env: WebRuntimeEnv): Promise<SelfHostedWebComposition> {
  const db = createDatabase(env.databaseUrl);
  const workspaceId = await ensureLocalWorkspace(db);
  const localRepositories = createWorkspaceRepositories(db, workspaceId);
  const configuration = createSelfHostedConfigurationProbe(workspaceId);
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
    readEffectiveConfiguration: () => readSelfHostedEffectiveConfiguration(configuration),
  });

  return {
    db,
    workspaceId,
    localRepositories,
    services,
    configuration,
    close: () => db.destroy(),
  };
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

async function readSelfHostedEffectiveConfiguration(
  configuration: SelfHostedConfigurationProbe,
): Promise<EffectiveConfigurationOverview> {
  const result = await configuration.resolve({ repositoryDocument: null });
  return {
    trustedPath: result.provenance.repositoryPath,
    trustedRevision: result.provenance.repositoryRevision ?? "self-hosted-probe",
    repositoryRevision: result.provenance.repositoryRevision,
    inheritanceMode: result.provenance.inheritanceMode,
    effectiveHash: result.provenance.effectiveHash,
    values: result.ok ? flattenConfigurationValues(result.config, result.provenance.sources) : [],
  };
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
