import {
  createInstallationRequester,
  GitHubAdapter,
  type GitHubAppCredentials,
} from "@triagepilot/github";
import { trustedBaseSha, type ScoreComponent } from "@triagepilot/shared";
import {
  createJobQueue,
  findLatestHumanReviewPolicyDecision,
  markActionFailed as persistActionFailed,
  markActionSucceeded as persistActionSucceeded,
  persistDecision as persistRoutingDecision,
  recordPolicyCheck,
  updatePolicyCheckState,
  type createDatabase,
} from "@triagepilot/db";
import type { ChangedFileMetadata } from "@triagepilot/core";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/shared";

import type { RoutingJobMessage, RoutingJobServices } from "./processor";
import { classifyWorkerError, PermanentJobError } from "./errors";
import { evaluateHumanReviewPolicy } from "./review-policy";
import type { HumanReviewPolicyServices } from "./review-policy-processor";

type Requester = Awaited<ReturnType<typeof createInstallationRequester>>;
type DatabaseClient = ReturnType<typeof createDatabase>;

export function createWorkerRoutingServiceFactory(input: {
  db: DatabaseClient;
  github: GitHubAppCredentials;
  createRequester?: typeof createInstallationRequester;
}): (message: RoutingJobMessage) => RoutingJobServices {
  return (message) => {
    let requesterPromise: Promise<Requester> | null = null;
    let repositoryIdPromise: Promise<string> | null = null;
    let pullRequestPromise: Promise<unknown> | null = null;
    let persistedDecisionId: string | null = null;

    async function requester(): Promise<Requester> {
      await repositoryId();
      requesterPromise ??= (input.createRequester ?? createInstallationRequester)({
        appId: input.github.appId,
        privateKey: input.github.privateKey,
        installationId: toSafeInteger(message.installationId),
      });
      return requesterPromise;
    }

    async function repositoryId(): Promise<string> {
      repositoryIdPromise ??= findKnownRepository(input.db, message);
      return repositoryIdPromise;
    }

    async function pullRequest(): Promise<unknown> {
      pullRequestPromise ??= (async () => {
        const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: message.owner,
          repo: message.repo,
          pull_number: message.pullNumber,
        });
        return response.data;
      })();
      return pullRequestPromise;
    }

    return {
      async fetchConfig() {
        try {
          const configRef = trustedBaseSha(message) ?? readNestedString(await pullRequest(), ["base", "sha"]);
          if (!configRef) throw new Error("pull request base SHA is unavailable");
          const response = await (await requester()).request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: message.owner,
            repo: message.repo,
            path: ".github/triagepilot.yml",
            ref: configRef,
          });
          return decodeGitHubContent(response.data);
        } catch (error) {
          if (isGitHubNotFound(error)) return "";
          throw error;
        }
      },

      async fetchChangedFiles() {
        const files: ChangedFileMetadata[] = [];
        for (let page = 1; ; page += 1) {
          const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
            owner: message.owner,
            repo: message.repo,
            pull_number: message.pullNumber,
            page,
            per_page: 100,
          });
          if (!Array.isArray(response.data)) return files;
          files.push(...response.data.map(toChangedFile));
          if (response.data.length < 100) return files;
        }
      },

      async fetchCommitMessages() {
        const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
          owner: message.owner,
          repo: message.repo,
          pull_number: message.pullNumber,
          per_page: 100,
        });
        return Array.isArray(response.data)
          ? response.data.map((commit) => readNestedString(commit, ["commit", "message"])).filter(Boolean)
          : [];
      },

      async fetchPullRequestMetadata() {
        const pullRequestData = await pullRequest();
        const authorLogin = readNestedString(pullRequestData, ["user", "login"]);
        return {
          authorLogin,
          authorHandle: authorLogin ? `@${authorLogin}` : "",
          branchName: readNestedString(pullRequestData, ["head", "ref"]),
          targetBranchName: readNestedString(pullRequestData, ["base", "ref"]),
        };
      },

      async fetchCurrentHeadApprovedReviewers() {
        const reviews = await new GitHubAdapter(await requester()).listPullRequestReviews({
          pullRequest: { owner: message.owner, repo: message.repo, pullNumber: message.pullNumber },
        });
        return reviews
          .filter(
            (review) =>
              review.userType === "User" && review.state === "APPROVED" && review.commitId === message.headSha,
          )
          .map((review) => `@${review.userLogin}`);
      },

      async enqueueHumanReviewPolicyEvaluation(policy) {
        await createJobQueue(input.db).enqueue({
          kind: "evaluate_human_review_policy",
          payload: { kind: "evaluate_human_review_policy", ...policy },
          idempotencyKey: `review-policy:${policy.deliveryId}`,
        });
      },

      async getReviewerLoad(reviewersInput) {
        return Object.fromEntries(reviewersInput.reviewers.map((reviewer) => [reviewer, 0]));
      },

      async updateRepositoryConfigState(state) {
        await input.db
          .updateTable("repositories")
          .set({
            config_state: state.configState,
            last_config_mode: state.mode,
            updated_at: new Date(),
          })
          .where("id", "=", await repositoryId())
          .execute();
      },

      async persistDecision(decision) {
        const persisted = await persistRoutingDecision(input.db, {
          repositoryId: await repositoryId(),
          ...decision,
        });
        persistedDecisionId = persisted.decisionId;
        return persisted;
      },

      async markActionSucceeded(decisionId, at) {
        await persistActionSucceeded(input.db, decisionId, at);
      },

      async markActionFailed(decisionId, error, at) {
        await persistActionFailed(input.db, decisionId, error, at);
      },

      async applyDecisionActions(action) {
        persistedDecisionId = action.decisionId;
        const githubRequester = await requester();
        const pullRequest = {
          owner: message.owner,
          repo: message.repo,
          pullNumber: message.pullNumber,
        };
        const currentPullRequest = await githubRequester.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: message.owner,
          repo: message.repo,
          pull_number: message.pullNumber,
        });
        if (readNestedString(currentPullRequest.data, ["head", "sha"]) !== action.expectedHeadSha) {
          throw new PermanentJobError("pull request head changed before enforce actions");
        }

        const adapter = new GitHubAdapter(githubRequester);
        const route = action.action === "policy_approval"
          ? "no_human"
          : action.action === "no_eligible_reviewer"
            ? "no_eligible_reviewer"
            : "human_review";
        const evaluation = evaluateHumanReviewPolicy({
          route,
          selectedReviewers: action.selectedReviewers ?? [],
          headSha: action.expectedHeadSha,
          reviews: [],
        });
        const checkRun = { owner: message.owner, repo: message.repo, headSha: action.expectedHeadSha };
        const policyCheckRunId = await ensureInitialPolicyCheck({
          db: input.db,
          adapter,
          checkRun,
          decisionId: action.decisionId,
          appId: toSafeInteger(input.github.appId),
          state: evaluation.state,
          summary: evaluation.summary,
        });

        try {
          await adapter.writeRoutingCheck({
            checkRun,
            decisionId: action.decisionId,
            conclusion: "success",
            summary: action.noHumanReason ?? action.selectedReviewers?.join(", ") ?? action.action,
          });
          await adapter.syncRiskLabel({
            pullRequest,
            tier: action.riskTier,
          });
          await adapter.upsertRoutingComment({
            pullRequest,
            decisionId: action.decisionId,
            body: formatRoutingComment(action),
          });
          const reviewersToRequest = action.reviewersToRequest ?? action.selectedReviewers ?? [];
          if (route === "human_review" && reviewersToRequest.length) {
            await adapter.requestHumanReviewers({
              pullRequest,
              reviewers: reviewersToRequest,
            });
          }
          if (action.action === "policy_approval") {
            await adapter.submitPolicyApproval({
              pullRequest,
              expectedHeadSha: action.expectedHeadSha,
              decisionId: action.decisionId,
              body: "TriagePilot policy approval",
            });
          }
        } catch (error) {
          const classified = classifyWorkerError(error);
          if (classified instanceof PermanentJobError) {
            const summary = `TriagePilot routing action failed: ${classified.message}`;
            await adapter.updateHumanReviewPolicyCheck({
              checkRun,
              checkRunId: policyCheckRunId,
              state: "failure",
              summary,
            });
            await updatePolicyCheckState(input.db, { decisionId: action.decisionId, state: "failure" });
          }
          throw error;
        }
      },

      async failPolicyCheck(summary) {
        persistedDecisionId ??= await findDecisionIdForDelivery(
          input.db,
          message.deliveryId,
          message.headSha,
        );
        if (persistedDecisionId === null) return;
        const adapter = new GitHubAdapter(await requester());
        const checkRun = { owner: message.owner, repo: message.repo, headSha: message.headSha };
        const recordedCheckRunId = await findRecordedPolicyCheckRunId(
          input.db,
          persistedDecisionId,
          message.headSha,
        );
        const recovered = recordedCheckRunId === null
          ? await adapter.findHumanReviewPolicyCheck({
              checkRun,
              decisionId: persistedDecisionId,
              appId: toSafeInteger(input.github.appId),
            })
          : null;
        const checkRunId = recordedCheckRunId ?? recovered?.checkRunId ?? null;
        if (checkRunId === null) return;
        await adapter.updateHumanReviewPolicyCheck({
          checkRun,
          checkRunId,
          state: "failure",
          summary,
        });
        await recordPolicyCheck(input.db, {
          decisionId: persistedDecisionId,
          checkRunId,
          state: "failure",
        });
      },
    };
  };
}

function formatRoutingComment(input: {
  action: string;
  riskTier: string;
  risk?: {
    score: number;
    classifierVersion: string;
    components: ScoreComponent[];
  };
}): string {
  if (!input.risk) return `TriagePilot decision: ${input.action}`;

  const components = input.risk.components
    .map((component) => `- **${formatComponentScore(component)} ${labelForRiskComponent(component.reason)}** — ${component.detail}`)
    .join("\n");

  return [
    `TriagePilot decision: ${input.action}`,
    "",
    `**Risk score:** ${input.risk.score}/100 · **Tier:** ${input.riskTier}`,
    `**Classifier:** ${input.risk.classifierVersion}`,
    "",
    "<details>",
    "<summary>Score breakdown</summary>",
    "",
    components || "No score components were recorded.",
    "</details>",
  ].join("\n");
}

function formatComponentScore(component: ScoreComponent): string {
  return component.reason === "docs_or_test_suppressor" ? "cap" : component.score >= 0 ? `+${component.score}` : String(component.score);
}

function labelForRiskComponent(reason: string): string {
  const labels: Record<string, string> = {
    changed_file_count: "Changed file count",
    large_line_delta: "Large line delta",
    dependency_lockfile_change: "Dependency lockfile change",
    migration_or_schema_change: "Migration or schema change",
    ai_authorship_signal: "AI authorship signal",
    docs_or_test_suppressor: "Documentation or test-only cap",
  };
  if (reason.startsWith("high_risk_path:")) return `High-risk path: ${reason.slice("high_risk_path:".length)}`;
  return labels[reason] ?? reason.replaceAll("_", " ");
}

export function createWorkerHumanReviewPolicyServiceFactory(input: {
  db: DatabaseClient;
  github: GitHubAppCredentials;
  createRequester?: typeof createInstallationRequester;
}): (message: HumanReviewPolicyJobPayload) => HumanReviewPolicyServices {
  return (message) => {
    let requesterPromise: Promise<Requester> | null = null;
    let repositoryIdPromise: Promise<string> | null = null;
    let evaluatedDecisionId: string | null = null;

    async function repositoryId(): Promise<string> {
      repositoryIdPromise ??= findKnownRepository(input.db, message);
      return repositoryIdPromise;
    }

    async function requester(): Promise<Requester> {
      await repositoryId();
      requesterPromise ??= (input.createRequester ?? createInstallationRequester)({
        appId: input.github.appId,
        privateKey: input.github.privateKey,
        installationId: toSafeInteger(message.installationId),
      });
      return requesterPromise;
    }

    function pullRequestRef() {
      return { owner: message.owner, repo: message.repo, pullNumber: message.pullNumber };
    }

    async function findDecision() {
      const decision = await findLatestHumanReviewPolicyDecision(input.db, {
        repositoryId: await repositoryId(),
        pullNumber: message.pullNumber,
      });
      evaluatedDecisionId = decision?.decisionId ?? null;
      return decision;
    }

    return {
      async findDecision(decisionInput) {
        if (decisionInput.pullNumber !== message.pullNumber) return null;
        return await findDecision();
      },

      async fetchPullRequest() {
        const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: message.owner,
          repo: message.repo,
          pull_number: message.pullNumber,
        });
        return {
          state: readString(response.data, "state"),
          headSha: readNestedString(response.data, ["head", "sha"]),
        };
      },

      async fetchReviews() {
        return await new GitHubAdapter(await requester()).listPullRequestReviews({ pullRequest: pullRequestRef() });
      },

      async updateCheck(check) {
        if (check.state === "in_progress") {
          if (check.decision.policyCheckState === "failure") return;
          const adapter = new GitHubAdapter(await requester());
          const checkRun = {
            owner: check.decision.owner,
            repo: check.decision.repo,
            headSha: check.decision.headSha,
          };
          const existing = await adapter.findHumanReviewPolicyCheck({
            checkRun,
            decisionId: check.decision.decisionId,
            appId: toSafeInteger(input.github.appId),
          });
          if (existing?.state === "failure") {
            await updatePolicyCheckState(input.db, {
              decisionId: check.decision.decisionId,
              state: "failure",
            });
            throw new PermanentJobError("human-review policy check is already failed");
          }
          if (existing?.state === "in_progress") {
            if (
              existing.checkRunId !== check.decision.policyCheckRunId ||
              check.decision.policyCheckState !== "in_progress"
            ) {
              await recordPolicyCheck(input.db, {
                decisionId: check.decision.decisionId,
                checkRunId: existing.checkRunId,
                state: "in_progress",
              });
            }
            return;
          }
          const created = await adapter.createHumanReviewPolicyCheck({
            checkRun,
            decisionId: check.decision.decisionId,
            state: "in_progress",
            summary: check.summary,
          });
          await recordPolicyCheck(input.db, {
            decisionId: check.decision.decisionId,
            checkRunId: created.checkRunId,
            state: "in_progress",
          });
          return;
        }
        const adapter = new GitHubAdapter(await requester());
        const checkRun = {
          owner: check.decision.owner,
          repo: check.decision.repo,
          headSha: check.decision.headSha,
        };
        const existing = await adapter.findHumanReviewPolicyCheck({
          checkRun,
          decisionId: check.decision.decisionId,
          appId: toSafeInteger(input.github.appId),
        });
        if (existing?.state === "failure") {
          await recordPolicyCheck(input.db, {
            decisionId: check.decision.decisionId,
            checkRunId: existing.checkRunId,
            state: "failure",
          });
          if (check.state !== "failure") {
            throw new PermanentJobError("human-review policy check is already failed");
          }
          return;
        }
        const checkRunId = existing?.checkRunId ?? check.decision.policyCheckRunId;
        if (checkRunId === null) {
          throw new Error("human-review policy check run is unavailable");
        }
        await adapter.updateHumanReviewPolicyCheck({
          checkRun,
          checkRunId,
          state: check.state,
          summary: check.summary,
        });
        if (checkRunId !== check.decision.policyCheckRunId) {
          await recordPolicyCheck(input.db, {
            decisionId: check.decision.decisionId,
            checkRunId,
            state: check.state,
          });
        }
      },

      async persistState(state) {
        await updatePolicyCheckState(input.db, state);
      },

      policyCheckFailureDecisionId() {
        return evaluatedDecisionId;
      },

      async failPolicyCheck(summary, decisionId) {
        const decision = decisionId
          ? await findPolicyCheckDecision(input.db, {
              decisionId,
              repositoryId: await repositoryId(),
              pullNumber: message.pullNumber,
              owner: message.owner,
              repo: message.repo,
            })
          : await findDecision();
        if (!decision || decision.policyCheckState === "failure") return;
        const adapter = new GitHubAdapter(await requester());
        const checkRun = { owner: decision.owner, repo: decision.repo, headSha: decision.headSha };
        const recovered = await adapter.findHumanReviewPolicyCheck({
          checkRun,
          decisionId: decision.decisionId,
          appId: toSafeInteger(input.github.appId),
        });
        if (recovered?.state === "failure") {
          await recordPolicyCheck(input.db, {
            decisionId: decision.decisionId,
            checkRunId: recovered.checkRunId,
            state: "failure",
          });
          return;
        }
        const checkRunId = recovered?.checkRunId ?? decision.policyCheckRunId;
        if (checkRunId === null) return;
        await adapter.updateHumanReviewPolicyCheck({
          checkRun,
          checkRunId,
          state: "failure",
          summary,
        });
        await recordPolicyCheck(input.db, {
          decisionId: decision.decisionId,
          checkRunId,
          state: "failure",
        });
      },
    };
  };
}

async function findKnownRepository(
  db: DatabaseClient,
  message: Pick<RoutingJobMessage, "repositoryId" | "installationId">,
): Promise<string> {
  const repository = await db
    .selectFrom("repositories")
    .innerJoin("installations", "installations.id", "repositories.installation_id")
    .select("repositories.id")
    .where("repositories.github_repository_id", "=", message.repositoryId)
    .where("installations.github_installation_id", "=", message.installationId)
    .where("installations.status", "=", "active")
    .executeTakeFirst();
  if (!repository) {
    throw new Error(`repository ${message.repositoryId} is not known`);
  }
  return repository.id;
}

async function findRecordedPolicyCheckRunId(
  db: DatabaseClient,
  decisionId: string,
  headSha: string,
): Promise<string | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select(["policy_check_run_id as checkRunId", "head_sha as headSha"])
    .where("id", "=", decisionId)
    .executeTakeFirst();
  if (!decision || decision.headSha !== headSha) return null;
  return decision.checkRunId;
}

async function findDecisionIdForDelivery(
  db: DatabaseClient,
  deliveryId: string,
  headSha: string,
): Promise<string | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select(["id as decisionId", "head_sha as headSha"])
    .where("delivery_id", "=", deliveryId)
    .executeTakeFirst();
  return decision?.headSha === headSha ? decision.decisionId : null;
}

async function findPolicyCheckDecision(
  db: DatabaseClient,
  input: {
    decisionId: string;
    repositoryId: string;
    pullNumber: number;
    owner: string;
    repo: string;
  },
): Promise<{
  decisionId: string;
  owner: string;
  repo: string;
  headSha: string;
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
} | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select([
      "id as decisionId",
      "repository_id as repositoryId",
      "pull_number as pullNumber",
      "head_sha as headSha",
      "mode",
      "policy_check_run_id as policyCheckRunId",
      "policy_check_state as policyCheckState",
    ])
    .where("id", "=", input.decisionId)
    .executeTakeFirst();
  if (
    !decision ||
    decision.repositoryId !== input.repositoryId ||
    decision.pullNumber !== input.pullNumber ||
    decision.headSha === null ||
    decision.mode !== "enforce"
  ) return null;
  return {
    decisionId: decision.decisionId,
    owner: input.owner,
    repo: input.repo,
    headSha: decision.headSha,
    policyCheckRunId: decision.policyCheckRunId,
    policyCheckState: decision.policyCheckState,
  };
}

async function ensureInitialPolicyCheck(input: {
  db: DatabaseClient;
  adapter: GitHubAdapter;
  checkRun: { owner: string; repo: string; headSha: string };
  decisionId: string;
  appId: number;
  state: "in_progress" | "success" | "failure";
  summary: string;
}): Promise<string> {
  const recordedCheckRunId = await findRecordedPolicyCheckRunId(
    input.db,
    input.decisionId,
    input.checkRun.headSha,
  );
  if (recordedCheckRunId !== null) return recordedCheckRunId;

  const existing = await input.adapter.findHumanReviewPolicyCheck({
    checkRun: input.checkRun,
    decisionId: input.decisionId,
    appId: input.appId,
  });
  if (existing !== null) {
    await recordPolicyCheck(input.db, {
      decisionId: input.decisionId,
      checkRunId: existing.checkRunId,
      state: existing.state,
    });
    return existing.checkRunId;
  }

  const created = await input.adapter.createHumanReviewPolicyCheck({
    checkRun: input.checkRun,
    decisionId: input.decisionId,
    state: input.state,
    summary: input.summary,
  });
  await recordPolicyCheck(input.db, {
    decisionId: input.decisionId,
    checkRunId: created.checkRunId,
    state: input.state,
  });
  return created.checkRunId;
}

function decodeGitHubContent(data: unknown): string {
  if (typeof data !== "object" || data === null || !("content" in data)) return "";
  const content = String(data.content).replace(/\s/g, "");
  return Buffer.from(content, "base64").toString("utf8");
}

function toChangedFile(file: unknown): ChangedFileMetadata {
  return {
    path: readString(file, "filename"),
    additions: readNumber(file, "additions"),
    deletions: readNumber(file, "deletions"),
  };
}

function readString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || !(key in value)) return "";
  return String(value[key as keyof typeof value]);
}

function readNumber(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null || !(key in value)) return 0;
  const parsed = Number(value[key as keyof typeof value]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !(part in current)) return "";
    current = current[part as keyof typeof current];
  }
  return typeof current === "string" ? current : "";
}

function isGitHubNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

function toSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error("GitHub ID must be a safe decimal integer");
  }
  return parsed;
}
