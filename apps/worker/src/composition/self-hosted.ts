import { resolveConfiguration } from "@triagepilot/config";
import type {
  Clock,
  ConfigurationDocument,
  ConfigurationSource,
  PlatformEventSink,
  RepositoryRef,
  WorkspaceId,
} from "@triagepilot/contracts";
import {
  createDatabase,
  createPlatformOutboxRepository,
  createJobClaimer,
  createWorkspaceRepositories,
  ensureLocalWorkspace,
  publishPlatformOutbox,
  updateWorkerHeartbeat,
  type WorkspaceRepositories,
} from "@triagepilot/db";
import {
  createInstallationRequester,
  GitHubAdapter,
  GitHubConfigurationSource,
  GitHubCredentialProvider,
} from "@triagepilot/provider-github";

import type { WorkerEnv } from "../env.js";
import { runPlatformOutboxDrain, runWorkerMaintenance, runWorkerStartup } from "../maintenance.js";
import type { RoutingJobMessage, RoutingJobServices } from "../processor.js";
import { processRoutingJob } from "../processor.js";
import { processHumanReviewPolicyJob } from "../review-policy-processor.js";
import type { HumanReviewPolicyServices } from "../review-policy-processor.js";
import {
  markReviewerReplacementRecoveryExhausted,
  processReviewerAbsenceActivationJob,
  recoverReviewerReplacementFinalizer,
  type ReviewerAbsenceActivationJobMessage,
  type ReviewerAvailabilityServices,
} from "../availability-processor.js";
import { runWorkerOnce } from "../runner.js";
import {
  createNoopPlatformEventSink,
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerReviewerAvailabilityServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../runtime-services.js";

type DatabaseClient = ReturnType<typeof createDatabase>;
type RequesterFactory = typeof createInstallationRequester;

export interface SelfHostedConfigurationProbeInput {
  repositoryDocument: string | null;
}

export interface SelfHostedConfigurationProbe {
  allowOrganizationEnforce: false;
  resolve(input: SelfHostedConfigurationProbeInput): ReturnType<typeof resolveConfiguration>;
}

export interface SelfHostedWorkerCompositionDependencies {
  createRequester?: RequesterFactory;
  clock?: Clock;
  platformEventSink?: PlatformEventSink;
}

export interface SelfHostedWorkerComposition {
  db: DatabaseClient;
  workspaceId: WorkspaceId;
  localRepositories: WorkspaceRepositories;
  jobClaimer: ReturnType<typeof createJobClaimer>;
  configuration: SelfHostedConfigurationProbe;
  buildRoutingServices(message: RoutingJobMessage): RoutingJobServices;
  buildHumanReviewPolicyServices(message: Parameters<typeof processHumanReviewPolicyJob>[0]): HumanReviewPolicyServices;
  buildReviewerAvailabilityServices(message: ReviewerAbsenceActivationJobMessage): ReviewerAvailabilityServices;
  runOnce(now: Date): Promise<boolean>;
  runStartup(now: Date): ReturnType<typeof runWorkerStartup>;
  runMaintenance(state: Awaited<ReturnType<typeof runWorkerStartup>>, now: Date): ReturnType<typeof runWorkerMaintenance>;
  drainPlatformOutbox(now: Date): ReturnType<typeof runPlatformOutboxDrain>;
  close(): Promise<void>;
}

export async function createSelfHostedWorkerComposition(
  env: WorkerEnv,
  dependencies: SelfHostedWorkerCompositionDependencies = {},
): Promise<SelfHostedWorkerComposition> {
  const db = createDatabase(env.databaseUrl);
  const workspaceId = await ensureLocalWorkspace(db);
  const localRepositories = createWorkspaceRepositories(db, workspaceId);
  const platformOutbox = createPlatformOutboxRepository(db, workspaceId);
  const jobClaimer = createJobClaimer(db);
  const clock = dependencies.clock ?? { now: () => new Date() };
  const platformEventSink = dependencies.platformEventSink ?? createNoopPlatformEventSink();
  const credentialProvider = new GitHubCredentialProvider(env.github);
  const createRequester = dependencies.createRequester ?? createInstallationRequester;
  const buildRoutingServices = createWorkerRoutingServiceFactory({
    db,
    credentialProvider,
    createRequester,
    createAdapter: (requester) => new GitHubAdapter(requester),
    createConfigurationSource: (requester) => new GitHubConfigurationSource(requester),
    clock,
  });
  const buildHumanReviewPolicyServices = createWorkerHumanReviewPolicyServiceFactory({
    db,
    credentialProvider,
    createRequester,
    createAdapter: (requester) => new GitHubAdapter(requester),
  });
  const buildReviewerAvailabilityServices = createWorkerReviewerAvailabilityServiceFactory({
    db,
    credentialProvider,
    createRequester,
    createAdapter: (requester) => new GitHubAdapter(requester),
    clock,
  });
  const maintenanceServices = {
    async recoverStaleJobs(now: Date) {
      await localRepositories.recoverStaleJobs(now);
    },
    async cleanupRevokedProviderConnections(now: Date) {
      await localRepositories.cleanupRevokedProviderConnections(now);
    },
    async applyRetention(now: Date) {
      await localRepositories.applyFixedRetention(now);
    },
    async updateHeartbeat(now: Date) {
      await updateWorkerHeartbeat(db, { workerId: env.workerId, now });
    },
    async drainPlatformOutbox(now: Date) {
      await publishPlatformOutbox({ repository: platformOutbox, sink: platformEventSink, limit: 25, now });
    },
  };

  return {
    db,
    workspaceId,
    localRepositories,
    jobClaimer,
    configuration: createSelfHostedConfigurationProbe(workspaceId),
    buildRoutingServices,
    buildHumanReviewPolicyServices,
    buildReviewerAvailabilityServices,
    runOnce(now) {
      return runWorkerOnce({
        jobClaimer,
        workspaceQueue: (claimedWorkspaceId) => createWorkspaceRepositories(db, claimedWorkspaceId).jobs,
        workerId: env.workerId,
        now,
        processRoutingJob,
        buildRoutingServices,
        processHumanReviewPolicyJob,
        buildHumanReviewPolicyServices,
        processReviewerAbsenceActivationJob,
        recoverReviewerReplacementFinalizer,
        markReviewerReplacementRecoveryExhausted,
        buildReviewerAvailabilityServices,
      });
    },
    runStartup(now) {
      return runWorkerStartup(maintenanceServices, now);
    },
    runMaintenance(state, now) {
      return runWorkerMaintenance(state, maintenanceServices, now);
    },
    drainPlatformOutbox(now) {
      return runPlatformOutboxDrain(maintenanceServices, now);
    },
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
