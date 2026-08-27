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
  createJobQueue,
  findRoutingRecoveryTarget,
  type createDatabase,
} from "@triagepilot/db";
import { createInstallationRequester, type GitHubAppCredentialShape } from "@triagepilot/github";
import { buildRoutingKey } from "@triagepilot/shared";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import type { WebServices } from "./app";
import { parsePullRequestUrl, RoutingRunError } from "./routing-run";

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
  createRequester?: typeof createInstallationRequester;
  createId?: () => string;
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

    async rerunRouting(request) {
      const lookup = "decisionId" in request
        ? { githubOrganization: input.githubOrganization, decisionId: request.decisionId }
        : (() => {
            const pullRequest = parsePullRequestUrl(request.pullRequestUrl);
            if (!pullRequest) {
              throw new RoutingRunError("Enter a valid GitHub pull request URL.", 422, "invalid_pull_request");
            }
            return { githubOrganization: input.githubOrganization, ...pullRequest };
          })();
      const target = await findRoutingRecoveryTarget(input.db, lookup);
      if (!target) {
        throw new RoutingRunError("The pull request is not part of an active configured repository.", 404, "not_found");
      }
      const requester = await (input.createRequester ?? createInstallationRequester)({
        appId: input.github.appId,
        privateKey: input.github.privateKey,
        installationId: toSafeInteger(target.githubInstallationId),
      });
      const response = await requester.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
      }).catch((error: unknown) => {
        if (hasStatus(error, 404)) {
          throw new RoutingRunError("GitHub could not find that pull request.", 404, "not_found");
        }
        throw error;
      });
      const pullRequest = readPullRequestState(response.data);
      if (!pullRequest) {
        throw new RoutingRunError("GitHub returned an incomplete pull request state.", 422, "invalid_pull_request");
      }
      if (pullRequest.state !== "open") {
        throw new RoutingRunError("Only an open pull request can be routed again.", 409, "pull_request_closed");
      }
      const runId = (input.createId ?? randomUUID)();
      const semanticKey = buildRoutingKey({
        repositoryId: target.githubRepositoryId,
        pullNumber: target.pullNumber,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        isDraft: pullRequest.isDraft,
      });
      const routingKey = `${semanticKey}:rerun:${runId}`;
      const queued = await createJobQueue(input.db).enqueue({
        kind: "process_pull_request",
        idempotencyKey: routingKey,
        payload: {
          kind: "process_pull_request",
          deliveryId: `operator-rerun:${runId}`,
          installationId: target.githubInstallationId,
          repositoryId: target.githubRepositoryId,
          owner: target.owner,
          repo: target.repo,
          pullNumber: target.pullNumber,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          isDraft: pullRequest.isDraft,
          eventName: "operator.rerun",
          routingKey,
        },
      });
      return { jobId: queued.jobId };
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

function readPullRequestState(value: unknown): {
  state: string;
  baseSha: string;
  headSha: string;
  isDraft: boolean;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const baseSha = readNestedString(record, "base", "sha");
  const headSha = readNestedString(record, "head", "sha");
  if (typeof record.state !== "string" || typeof record.draft !== "boolean" || !baseSha || !headSha) return null;
  return { state: record.state, baseSha, headSha, isDraft: record.draft };
}

function readNestedString(value: Record<string, unknown>, parent: string, child: string): string {
  const nested = value[parent];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return "";
  const result = (nested as Record<string, unknown>)[child];
  return typeof result === "string" ? result : "";
}

function toSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("GitHub installation ID is invalid");
  return parsed;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}
