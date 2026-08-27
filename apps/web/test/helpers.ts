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
      organization: "acme",
      githubApp: { appId: "123", configured: false, installationId: null },
      repositories: [],
      decisions: [],
      failures: { jobs: [], actions: [] },
      worker: { available: false, workerId: null, lastHeartbeatAt: null },
    }),
    readEffectiveConfiguration: async () => ({
      trustedPath: null,
      trustedRevision: "self-hosted-probe",
      repositoryRevision: null,
      inheritanceMode: "defaults",
      effectiveHash: "a".repeat(64),
      values: [],
    }),
    ...overrides,
  };
}
