import { normalizeGitHubWebhook } from "@triagepilot/provider-github";

import type { WebServices } from "../src/app";

export function buildServices(overrides: Partial<WebServices> = {}): WebServices {
  return {
    adminUsername: "admin",
    adminPassword: "correct-password",
    sessionSecret: "s".repeat(32),
    secureCookies: false,
    now: () => new Date("2026-08-18T10:00:00.000Z"),
    sourceAddress: () => "203.0.113.8",
    checkDatabase: async () => {},
    verifySignature: async () => {},
    normalizeGitHubWebhook,
    getWebhookSecret: async () => "hook-secret",
    githubOrganization: "acme",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    acceptRoutingDelivery: async () => ({ inserted: true, jobId: "job-1" }),
    acceptHumanReviewPolicyDelivery: async () => ({ inserted: true, jobId: "job-review-1" }),
    activateConfiguredInstallation: async () => {},
    replaceInstallationRepositories: async () => {},
    updateInstallationRepositories: async () => {},
    suspendConfiguredInstallation: async () => {},
    deleteConfiguredInstallation: async () => {},
    logIgnoredWebhook: () => {},
    listOperationsOverview: async () => ({
      statuses: [
        { id: "workspace", label: "Organization", value: "acme" },
        { id: "connection", label: "GitHub App", value: "Not configured", detail: "No active installation" },
      ],
      repositories: [],
      decisions: [],
      failures: { jobs: [], actions: [] },
      worker: { available: false, workerId: null, lastHeartbeatAt: null },
    }),
    readEffectiveConfiguration: async () => ({
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      trustedPath: null,
      trustedRevision: "self-hosted-probe",
      repositoryRevision: null,
      inheritanceMode: "defaults",
      effectiveHash: "a".repeat(64),
      values: [],
    }),
    readAvailabilitySettings: async () => ({ timezone: "UTC", updatedAt: "2026-08-18T10:00:00.000Z" }),
    updateAvailabilityTimezone: async ({ timezone }) => ({ timezone, updatedAt: "2026-08-18T10:00:00.000Z" }),
    listReviewerAbsences: async () => [],
    scheduleReviewerAbsence: async (input) => ({
      id: "absence-1", externalActorId: input.externalActorId, startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(), status: "upcoming", revision: 1, cancelledAt: null,
      createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
    }),
    reviseReviewerAbsence: async (input) => ({
      id: input.absenceId, externalActorId: input.externalActorId, startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(), status: "upcoming", revision: input.expectedRevision + 1, cancelledAt: null,
      createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
    }),
    cancelReviewerAbsence: async (input) => ({
      id: input.absenceId, externalActorId: "@user-d82a5f", startAt: input.now.toISOString(),
      endAt: new Date(input.now.getTime() + 3_600_000).toISOString(), status: "cancelled", revision: input.expectedRevision + 1,
      cancelledAt: input.now.toISOString(), createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
    }),
    listReviewerReplacementHistory: async () => [],
    queueRoutingRecovery: async () => ({ jobId: "job-recovery-1" }),
    ...overrides,
  };
}
