import {
  acceptHumanReviewPolicyDelivery,
  acceptRoutingDelivery,
  activateConfiguredInstallation,
  cancelReviewerAbsence,
  createReviewerAbsence,
  deleteConfiguredInstallation,
  readOperationsOverview,
  replaceInstallationRepositories,
  readAvailabilityOverview,
  suspendConfiguredInstallation,
  updateOrganizationTimezone,
  updateReviewerAbsence,
  updateInstallationRepositories,
  type createDatabase,
} from "@triagepilot/db";
import type { GitHubAppCredentialShape } from "@triagepilot/github";
import { sql } from "kysely";

import type { WebServices } from "./app";

interface WebRuntimeServicesInput {
  db: ReturnType<typeof createDatabase>;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  secureCookies: boolean;
  now: WebServices["now"];
  sourceAddress: WebServices["sourceAddress"];
  githubOrganization: string;
  github: GitHubAppCredentialShape;
  verifySignature: WebServices["verifySignature"];
}

export function createWebRuntimeServices(input: WebRuntimeServicesInput): WebServices {
  return {
    adminUsername: input.adminUsername,
    adminPassword: input.adminPassword,
    sessionSecret: input.sessionSecret,
    secureCookies: input.secureCookies,
    now: input.now,
    sourceAddress: input.sourceAddress,
    githubOrganization: input.githubOrganization,
    verifySignature: input.verifySignature,

    async checkDatabase() {
      await sql`select 1`.execute(input.db);
    },

    async getWebhookSecret() {
      return input.github.webhookSecret;
    },

    async acceptRoutingDelivery(delivery) {
      return await acceptRoutingDelivery(input.db, delivery);
    },

    async acceptHumanReviewPolicyDelivery(delivery) {
      return await acceptHumanReviewPolicyDelivery(input.db, delivery);
    },

    async activateConfiguredInstallation(installation) {
      await activateConfiguredInstallation(input.db, installation);
    },

    async replaceInstallationRepositories(installation) {
      await replaceInstallationRepositories(input.db, installation);
    },

    async updateInstallationRepositories(installation) {
      await updateInstallationRepositories(input.db, installation);
    },

    async suspendConfiguredInstallation(installation) {
      await suspendConfiguredInstallation(input.db, installation);
    },

    async deleteConfiguredInstallation(installation) {
      await deleteConfiguredInstallation(input.db, installation);
    },

    logIgnoredWebhook(metadata) {
      console.warn(JSON.stringify({ message: "ignored out-of-scope GitHub webhook", ...metadata }));
    },

    async listOperationsOverview() {
      return await readOperationsOverview(input.db, {
        githubOrganization: input.githubOrganization,
        githubAppId: input.github.appId,
        now: input.now(),
        heartbeatStaleAfterMs: 30_000,
      });
    },

    async readAvailabilityOverview(availability) {
      return await readAvailabilityOverview(input.db, availability);
    },

    async updateOrganizationTimezone(availability) {
      await updateOrganizationTimezone(input.db, availability);
    },

    async createReviewerAbsence(absence) {
      return await createReviewerAbsence(input.db, absence);
    },

    async updateReviewerAbsence(absence) {
      return await updateReviewerAbsence(input.db, absence);
    },

    async cancelReviewerAbsence(absence) {
      return await cancelReviewerAbsence(input.db, absence);
    },
  };
}
