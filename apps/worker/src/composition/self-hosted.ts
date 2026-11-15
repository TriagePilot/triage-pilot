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
  requestQueueReconciliation,
  replayDeferredPullRequestDelivery,
  recoverDeferredPullRequestDelivery,
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

import { createWorkerReviewerBacklogService } from "../reviewer-backlog.js";
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
import { createWorkerPullRequestSync } from "../pull-request-sync.js";
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
  const reviewerBacklog = createWorkerReviewerBacklogService({ db, workspaceId, githubOrganization: env.githubOrganization, credentialProvider, createRequester, clock });
  const buildRoutingServices = createWorkerRoutingServiceFactory({
    db,
    reviewerBacklog,
    githubOrganization: env.githubOrganization,
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
    reviewerBacklog,
    credentialProvider,
    createRequester,
    createAdapter: (requester) => new GitHubAdapter(requester),
    clock,
  });
  const queueSync = createWorkerPullRequestSync({ db, github: env.github, githubOrganization: env.githubOrganization, createRequester });
  const maintenanceServices = {
    async scheduleQueueSync(now: Date, reason: "startup" | "scheduled") {
      const connections = await db.selectFrom("provider_connections").select(["id", "external_connection_id"]).where("workspace_id", "=", workspaceId).where("provider", "=", "github").where("status", "=", "active").execute();
      for (const connection of connections) {
        try { await requestQueueReconciliation(db, { workspaceId, providerConnectionId: connection.id, externalInstallationId: connection.external_connection_id }, reason, now); } catch { /* Retried during the next maintenance cycle. */ }
      }
    },
    async recoverStaleJobs(now: Date) {
      await localRepositories.recoverStaleJobs(now);
      await recoverDeferredPullRequestDelivery(db, workspaceId, now);
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
        processDeferredDelivery: (lease) => replayDeferredPullRequestDelivery(db, lease),
        async processQueueSyncJob(job, lease) {
          const payload = job.payload as Record<string, unknown>;
          if (!payload || payload.workspaceId !== job.workspaceId || payload.providerConnectionId !== job.providerConnectionId || payload.externalInstallationId !== job.externalInstallationId || typeof job.externalInstallationId !== "string" || job.provider !== "github") throw new Error("invalid queue job provenance");
          const scope = { workspaceId: job.workspaceId, providerConnectionId: job.providerConnectionId, externalInstallationId: job.externalInstallationId };
          if (job.kind === "reconcile_queue_connection") {
            if (typeof payload.runId !== "string") throw new Error("invalid queue run");
            await queueSync.reconcile(scope, payload.runId, lease);
          } else {
            if (typeof payload.repositoryId !== "string" || typeof payload.externalRepositoryId !== "string" || payload.externalRepositoryId !== job.externalRepositoryId || typeof payload.pullNumber !== "number" || !Number.isSafeInteger(payload.pullNumber) || payload.pullNumber <= 0) throw new Error("invalid queue pull");
            await queueSync.refresh({ ...scope, repositoryId: payload.repositoryId, externalRepositoryId: payload.externalRepositoryId, pullNumber: payload.pullNumber }, lease);
          }
        },
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
