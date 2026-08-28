import {
  createInstallationRequester,
  GitHubAdapter,
  GitHubConfigurationSource,
  type GitHubAppCredentials,
} from "@triagepilot/provider-github";
import { resolveConfiguration as resolveEffectiveConfiguration } from "@triagepilot/config";
import {
  trustedBaseSha,
  type Clock,
  type ConfigurationSource,
  type CredentialProvider,
  type DecisionEventSink,
  type HumanReviewPolicyJobPayload,
  type ScoreComponent,
} from "@triagepilot/contracts";
import {
  createWorkspaceJobQueue,
  findLatestHumanReviewPolicyDecision,
  markActionFailed as persistActionFailed,
  markActionSucceeded as persistActionSucceeded,
  persistDecisionWithEvent,
  recordPolicyCheck,
  updatePolicyCheckState,
  type createDatabase,
} from "@triagepilot/db";
import {
  activeApprovedReviewers,
  evaluateHumanReviewPolicy,
  type ChangedFileMetadata,
  type ReviewMetadata,
} from "@triagepilot/core";
import type { ReviewPolicyApplicationPorts, RoutingApplicationPorts } from "@triagepilot/application";

import type { RoutingJobMessage, RoutingJobServices } from "./processor";
import { classifyWorkerError, PermanentJobError } from "./errors";
import type { HumanReviewPolicyServices } from "./review-policy-processor";

type Requester = Awaited<ReturnType<typeof createInstallationRequester>>;
type DatabaseClient = ReturnType<typeof createDatabase>;
type AdapterFactory = (requester: Requester) => GitHubAdapter;
type ConfigurationSourceFactory = (requester: Requester) => ConfigurationSource;

interface WorkerServiceFactoryInput {
  db: DatabaseClient;
  github?: GitHubAppCredentials;
  credentialProvider?: CredentialProvider<GitHubAppCredentials>;
  createRequester?: typeof createInstallationRequester;
  createAdapter?: AdapterFactory;
  createConfigurationSource?: ConfigurationSourceFactory;
  clock?: Clock;
}

export function createNoopDecisionEventSink(): DecisionEventSink {
  return { async emit() {} };
}

function staticCredentialProvider(
  github: GitHubAppCredentials | undefined,
): CredentialProvider<GitHubAppCredentials> {
  if (github === undefined) {
    throw new Error("GitHub credential provider is required");
  }
  return {
    async getCredential() {
      return github;
    },
  };
}

export function createWorkerRoutingServiceFactory(input: WorkerServiceFactoryInput) {
  const credentialProvider = input.credentialProvider ?? staticCredentialProvider(input.github);
  const createAdapter = input.createAdapter ?? ((requester: Requester) => new GitHubAdapter(requester));
  const createConfigurationSource =
    input.createConfigurationSource ?? ((requester: Requester) => new GitHubConfigurationSource(requester));
  return (message: RoutingJobMessage) => {
    const { changeRequest } = message;
    const { repository } = changeRequest;
    let requesterPromise: Promise<Requester> | null = null;
    let knownRepositoryPromise: Promise<KnownRepository> | null = null;
    let pullRequestPromise: Promise<unknown> | null = null;
    let persistedDecisionId: string | null = null;
    const clock = input.clock ?? { now: () => new Date() };

    async function requester(): Promise<Requester> {
      await repositoryId();
      const credentials = await credentialProvider.getCredential({
        workspaceId: message.workspaceId,
        providerConnectionId: message.providerConnectionId,
      });
      requesterPromise ??= (input.createRequester ?? createInstallationRequester)({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId: toSafeInteger((await knownRepository()).externalConnectionId),
      });
      return requesterPromise;
    }

    async function repositoryId(): Promise<string> {
      return (await knownRepository()).repositoryId;
    }

    async function knownRepository(): Promise<KnownRepository> {
      knownRepositoryPromise ??= findKnownRepository(input.db, message);
      return knownRepositoryPromise;
    }

    async function pullRequest(): Promise<unknown> {
      pullRequestPromise ??= (async () => {
        const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: repository.owner,
          repo: repository.name,
          pull_number: changeRequest.number,
        });
        return response.data;
      })();
      return pullRequestPromise;
    }

    const services: RoutingJobServices = {
      async resolveConfiguration() {
        const trustedRevision = trustedBaseSha(message) ?? readNestedString(await pullRequest(), ["base", "sha"]);
        if (!trustedRevision) throw new Error("pull request base SHA is unavailable");
        const result = await resolveEffectiveConfiguration({
          workspaceId: message.workspaceId,
          repository,
          trustedRevision,
          source: createConfigurationSource(await requester()),
          allowOrganizationEnforce: false,
        });
        await input.db
          .updateTable("repositories")
          .set({
            config_state: result.ok ? "valid" : "invalid",
            last_config_mode: result.ok ? result.config.mode : "shadow",
            updated_at: new Date(),
          })
          .where("workspace_id", "=", message.workspaceId)
          .where("id", "=", await repositoryId())
          .execute();
        return result;
      },

      provider: {
        async fetchChangeRequestMetadata() {
          const pullRequestData = await pullRequest();
          const author = readNestedString(pullRequestData, ["user", "login"]);
          return {
            author,
            sourceBranch: readNestedString(pullRequestData, ["head", "ref"]),
            targetBranch: readNestedString(pullRequestData, ["base", "ref"]),
            currentHeadRevision: readNestedString(pullRequestData, ["head", "sha"]),
          };
        },

        async fetchChangedFiles() {
          const files: ChangedFileMetadata[] = [];
          for (let page = 1; ; page += 1) {
            const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
              owner: repository.owner,
              repo: repository.name,
              pull_number: changeRequest.number,
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
            owner: repository.owner,
            repo: repository.name,
            pull_number: changeRequest.number,
            per_page: 100,
          });
          return Array.isArray(response.data)
            ? response.data.map((commit) => readNestedString(commit, ["commit", "message"])).filter(Boolean)
            : [];
        },

        async fetchCurrentRevisionApprovals() {
          const reviews = await createAdapter(await requester()).listPullRequestReviews({
            pullRequest: { owner: repository.owner, repo: repository.name, pullNumber: changeRequest.number },
          });
          return activeApprovedReviewers(reviews.map(toReviewMetadata));
        },

        async applyActions(action) {
          persistedDecisionId = action.decisionId;
          const githubRequester = await requester();
          const pullRequest = {
            owner: repository.owner,
            repo: repository.name,
            pullNumber: changeRequest.number,
          };
          const currentPullRequest = await githubRequester.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner: repository.owner,
            repo: repository.name,
            pull_number: changeRequest.number,
          });
          if (readNestedString(currentPullRequest.data, ["head", "sha"]) !== action.expectedHeadRevision) {
            throw new PermanentJobError("pull request head changed before enforce actions");
          }

          const adapter = createAdapter(githubRequester);
          const route = action.action === "policy_approval"
            ? "no_human"
            : action.action === "no_eligible_reviewer"
              ? "no_eligible_reviewer"
              : "human_review";
          const evaluation = evaluateHumanReviewPolicy({
            route,
            selectedReviewers: action.selectedActors,
            reviews: [],
          });
          const checkRun = { owner: repository.owner, repo: repository.name, headSha: action.expectedHeadRevision };
          const policyCheckRunId = await ensureInitialPolicyCheck({
            db: input.db,
            workspaceId: message.workspaceId,
            adapter,
            checkRun,
            decisionId: action.decisionId,
            appId: toSafeInteger((await credentialProvider.getCredential({
              workspaceId: message.workspaceId,
              providerConnectionId: message.providerConnectionId,
            })).appId),
            state: evaluation.state,
            summary: evaluation.summary,
          });

          try {
            await adapter.writeRoutingCheck({
              checkRun,
              decisionId: action.decisionId,
              conclusion: "success",
              summary: action.noHumanReason ?? (action.selectedActors.join(", ") || action.action),
            });
            await adapter.syncRiskLabel({ pullRequest, tier: action.risk.tier });
            await adapter.upsertRoutingComment({
              pullRequest,
              decisionId: action.decisionId,
              body: formatRoutingComment({ action: action.action, riskTier: action.risk.tier, risk: action.risk }),
            });
            if (route === "human_review" && action.actorsToRequest.length > 0) {
              await adapter.requestHumanReviewers({ pullRequest, reviewers: action.actorsToRequest });
            }
            if (action.action === "policy_approval") {
              await adapter.submitPolicyApproval({
                pullRequest,
                expectedHeadSha: action.expectedHeadRevision,
                decisionId: action.decisionId,
                body: "TriagePilot policy approval",
              });
            }
          } catch (error) {
            const classified = classifyWorkerError(error);
            if (classified instanceof PermanentJobError) {
              const summary = `TriagePilot routing action failed: ${classified.message}`;
              await adapter.updateHumanReviewPolicyCheck({ checkRun, checkRunId: policyCheckRunId, state: "failure", summary });
              await updatePolicyCheckState(input.db, message.workspaceId, { decisionId: action.decisionId, state: "failure" });
            }
            throw error;
          }
        },
      },

      async enqueueReviewPolicy(policy) {
        await createWorkspaceJobQueue(input.db, message.workspaceId).enqueue({
          provider: repository.provider,
          providerConnectionId: message.providerConnectionId,
          kind: "evaluate_human_review_policy",
          payload: policy,
          idempotencyKey: `review-policy:${policy.deliveryId}`,
        });
      },

      async reviewerLoad(reviewersInput) {
        return Object.fromEntries(reviewersInput.actors.map((actor) => [actor, 0]));
      },

      decisions: {
        async persistWithEvent(decision, event) {
          const persisted = await persistDecisionWithEvent(input.db, message.workspaceId, {
            decision: {
              repositoryId: await repositoryId(),
              deliveryId: decision.deliveryId,
              routingKey: decision.routingKey,
              pullNumber: decision.changeRequestNumber,
              headSha: decision.headRevision,
              mode: decision.mode,
              action: decision.action,
              actionStatus: decision.actionStatus,
              riskScore: decision.riskScore,
              ...(decision.selectedActors === undefined ? {} : { selectedReviewers: decision.selectedActors }),
              ...(decision.noHumanReason === undefined ? {} : { noHumanReason: decision.noHumanReason }),
              details: decision.details,
              organizationConfigVersion: decision.organizationConfigVersion,
              repositoryConfigPath: decision.repositoryConfigPath,
              repositoryConfigRevision: decision.repositoryConfigRevision,
              ...(decision.effectiveConfigHash === null ? {} : { effectiveConfigHash: decision.effectiveConfigHash }),
              inheritanceMode: decision.inheritanceMode,
              configDiagnostics: decision.configDiagnostics,
              configSources: decision.configSources,
            },
            event,
          });
          persistedDecisionId = persisted.decisionId;
          return persisted;
        },

        async markActionSucceeded(decisionId, at) {
          await persistActionSucceeded(input.db, message.workspaceId, decisionId, at);
        },

        async markActionFailed(decisionId, error, at) {
          await persistActionFailed(input.db, message.workspaceId, decisionId, error, at);
        },
      },

      clock,

      async failPolicyCheck(summary) {
        persistedDecisionId ??= await findDecisionIdForDelivery(
          input.db,
          message.workspaceId,
          message.deliveryId,
          changeRequest.headRevision,
        );
        if (persistedDecisionId === null) return;
        const adapter = createAdapter(await requester());
        const checkRun = { owner: repository.owner, repo: repository.name, headSha: changeRequest.headRevision };
        const recordedCheckRunId = await findRecordedPolicyCheckRunId(
          input.db,
          message.workspaceId,
          persistedDecisionId,
          changeRequest.headRevision,
        );
        const recovered = recordedCheckRunId === null
          ? await adapter.findHumanReviewPolicyCheck({
              checkRun,
              decisionId: persistedDecisionId,
              appId: toSafeInteger((await credentialProvider.getCredential({
                workspaceId: message.workspaceId,
                providerConnectionId: message.providerConnectionId,
              })).appId),
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
        await recordPolicyCheck(input.db, message.workspaceId, {
          decisionId: persistedDecisionId,
          checkRunId,
          state: "failure",
        });
      },
    };
    const applicationServices = services as RoutingApplicationPorts;
    const compatibilityServices = Object.assign(services, {
      async fetchConfig(_job?: RoutingJobMessage) {
        const trustedRevision = trustedBaseSha(message) ?? readNestedString(await pullRequest(), ["base", "sha"]);
        if (!trustedRevision) throw new Error("pull request base SHA is unavailable");
        const document = await createConfigurationSource(await requester()).loadRepository({
          workspaceId: message.workspaceId,
          repository,
          trustedRevision,
        });
        return document?.content ?? "";
      },
      fetchChangedFiles: applicationServices.provider.fetchChangedFiles,
      fetchCommitMessages: applicationServices.provider.fetchCommitMessages,
      async fetchPullRequestMetadata() {
        const metadata = await applicationServices.provider.fetchChangeRequestMetadata(message);
        return {
          authorLogin: metadata.author.replace(/^@/, ""),
          authorHandle: metadata.author ? `@${metadata.author.replace(/^@/, "")}` : "",
          branchName: metadata.sourceBranch,
          targetBranchName: metadata.targetBranch,
        };
      },
      fetchActiveApprovedReviewers: applicationServices.provider.fetchCurrentRevisionApprovals,
      async enqueueHumanReviewPolicyEvaluation(policy: Omit<HumanReviewPolicyJobPayload, "kind">) {
        await applicationServices.enqueueReviewPolicy({ kind: "evaluate_human_review_policy", ...policy });
      },
      async getReviewerLoad(loadInput: { reviewers: string[] }) {
        return applicationServices.reviewerLoad({ workspaceId: message.workspaceId, actors: loadInput.reviewers });
      },
      async updateRepositoryConfigState(state: { configState: "valid" | "invalid"; mode: "shadow" | "enforce" }) {
        await input.db
          .updateTable("repositories")
          .set({ config_state: state.configState, last_config_mode: state.mode, updated_at: new Date() })
          .where("workspace_id", "=", message.workspaceId)
          .where("id", "=", await repositoryId())
          .execute();
      },
      markActionSucceeded: applicationServices.decisions.markActionSucceeded,
      markActionFailed: applicationServices.decisions.markActionFailed,
      async applyDecisionActions(action: {
        action: string;
        expectedHeadSha: string;
        decisionId: string;
        riskTier: "low" | "medium" | "high";
        risk?: { score: number; classifierVersion: "risk-v2"; components: ScoreComponent[]; tier?: "low" | "medium" | "high" };
        selectedReviewers?: string[];
        reviewersToRequest?: string[];
        noHumanReason?: string;
      }) {
        await applicationServices.provider.applyActions({
          workspaceId: message.workspaceId,
          providerConnectionId: message.providerConnectionId,
          repository,
          changeRequestId: changeRequest.externalId,
          changeRequestNumber: changeRequest.number,
          expectedHeadRevision: action.expectedHeadSha,
          decisionId: action.decisionId,
          action: action.action as "policy_approval" | "request_human_review" | "no_eligible_reviewer",
          risk: {
            classifierVersion: action.risk?.classifierVersion ?? "risk-v2",
            score: action.risk?.score ?? 0,
            tier: action.riskTier,
            components: action.risk?.components ?? [],
          },
          selectedActors: action.selectedReviewers ?? [],
          actorsToRequest: action.reviewersToRequest ?? action.selectedReviewers ?? [],
          ...(action.noHumanReason === undefined ? {} : { noHumanReason: action.noHumanReason }),
        });
      },
    });
    return compatibilityServices;
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

export function createWorkerHumanReviewPolicyServiceFactory(input: WorkerServiceFactoryInput) {
  const credentialProvider = input.credentialProvider ?? staticCredentialProvider(input.github);
  const createAdapter = input.createAdapter ?? ((requester: Requester) => new GitHubAdapter(requester));
  return (message: HumanReviewPolicyJobPayload) => {
    const { changeRequest } = message;
    const { repository } = changeRequest;
    let requesterPromise: Promise<Requester> | null = null;
    let knownRepositoryPromise: Promise<KnownRepository> | null = null;
    let evaluatedDecisionId: string | null = null;

    async function repositoryId(): Promise<string> {
      return (await knownRepository()).repositoryId;
    }

    async function knownRepository(): Promise<KnownRepository> {
      knownRepositoryPromise ??= findKnownRepository(input.db, message);
      return knownRepositoryPromise;
    }

    async function requester(): Promise<Requester> {
      await repositoryId();
      const credentials = await credentialProvider.getCredential({
        workspaceId: message.workspaceId,
        providerConnectionId: message.providerConnectionId,
      });
      requesterPromise ??= (input.createRequester ?? createInstallationRequester)({
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId: toSafeInteger((await knownRepository()).externalConnectionId),
      });
      return requesterPromise;
    }

    function pullRequestRef() {
      return { owner: repository.owner, repo: repository.name, pullNumber: changeRequest.number };
    }

    async function findDecision() {
      const decision = await findLatestHumanReviewPolicyDecision(input.db, message.workspaceId, {
        repositoryId: await repositoryId(),
        pullNumber: changeRequest.number,
      });
      evaluatedDecisionId = decision?.decisionId ?? null;
      return decision;
    }

    const services: HumanReviewPolicyServices = {
      decisions: {
        async findLatest(decisionInput) {
          if (
            decisionInput.workspaceId !== message.workspaceId ||
            decisionInput.repository.externalId !== repository.externalId ||
            decisionInput.changeRequestId !== changeRequest.externalId ||
            decisionInput.changeRequestNumber !== changeRequest.number
          ) return null;
          const found = await findDecision();
          if (found === null) return null;
          return {
            decisionId: found.decisionId,
            workspaceId: message.workspaceId,
            repository,
            changeRequestId: changeRequest.externalId,
            changeRequestNumber: found.pullNumber,
            headRevision: found.headSha,
            mode: found.mode,
            action: found.action,
            selectedActors: found.selectedReviewers,
            ...(found.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: found.requiredApprovalCount }),
            policyCheckRunId: found.policyCheckRunId,
            policyCheckState: found.policyCheckState,
          };
        },

        async persistState(state) {
          await updatePolicyCheckState(input.db, state.workspaceId, {
            decisionId: state.decisionId,
            state: state.state,
          });
        },
      },

      provider: {
        async fetchChangeRequestState() {
          const response = await (await requester()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner: repository.owner,
            repo: repository.name,
            pull_number: changeRequest.number,
          });
          return {
            state: readString(response.data, "state"),
            currentHeadRevision: readNestedString(response.data, ["head", "sha"]),
          };
        },

        async fetchReviews() {
          const reviews = await createAdapter(await requester()).listPullRequestReviews({ pullRequest: pullRequestRef() });
          return reviews.map(toReviewMetadata);
        },

        async updatePolicyCheck(check) {
        if (check.state === "in_progress") {
          if (check.decision.policyCheckState === "failure") return;
          const adapter = createAdapter(await requester());
          const checkRun = {
            owner: check.decision.repository.owner,
            repo: check.decision.repository.name,
            headSha: check.decision.headRevision,
          };
          const existing = await adapter.findHumanReviewPolicyCheck({
            checkRun,
            decisionId: check.decision.decisionId,
            appId: toSafeInteger((await credentialProvider.getCredential({
              workspaceId: message.workspaceId,
              providerConnectionId: message.providerConnectionId,
            })).appId),
          });
          if (existing?.state === "failure") {
            await updatePolicyCheckState(input.db, message.workspaceId, {
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
              await recordPolicyCheck(input.db, message.workspaceId, {
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
          await recordPolicyCheck(input.db, message.workspaceId, {
            decisionId: check.decision.decisionId,
            checkRunId: created.checkRunId,
            state: "in_progress",
          });
          return;
        }
        const adapter = createAdapter(await requester());
        const checkRun = {
          owner: check.decision.repository.owner,
          repo: check.decision.repository.name,
          headSha: check.decision.headRevision,
        };
        const existing = await adapter.findHumanReviewPolicyCheck({
          checkRun,
          decisionId: check.decision.decisionId,
          appId: toSafeInteger((await credentialProvider.getCredential({
            workspaceId: message.workspaceId,
            providerConnectionId: message.providerConnectionId,
          })).appId),
        });
        if (existing?.state === "failure") {
          await recordPolicyCheck(input.db, message.workspaceId, {
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
          await recordPolicyCheck(input.db, message.workspaceId, {
            decisionId: check.decision.decisionId,
            checkRunId,
            state: check.state,
          });
        }
      },
      },

      policyCheckFailureDecisionId() {
        return evaluatedDecisionId;
      },

      async failPolicyCheck(summary, decisionId) {
        const decision = decisionId
          ? await findPolicyCheckDecision(input.db, {
              workspaceId: message.workspaceId,
              decisionId,
              repositoryId: await repositoryId(),
              pullNumber: changeRequest.number,
              owner: repository.owner,
              repo: repository.name,
            })
          : await findDecision();
        if (!decision || decision.policyCheckState === "failure") return;
        const adapter = createAdapter(await requester());
        const checkRun = { owner: decision.owner, repo: decision.repo, headSha: decision.headSha };
        const recovered = await adapter.findHumanReviewPolicyCheck({
          checkRun,
          decisionId: decision.decisionId,
          appId: toSafeInteger((await credentialProvider.getCredential({
            workspaceId: message.workspaceId,
            providerConnectionId: message.providerConnectionId,
          })).appId),
        });
        if (recovered?.state === "failure") {
          await recordPolicyCheck(input.db, message.workspaceId, {
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
        await recordPolicyCheck(input.db, message.workspaceId, {
          decisionId: decision.decisionId,
          checkRunId,
          state: "failure",
        });
      },
    };
    const applicationServices = services as ReviewPolicyApplicationPorts;
    const compatibilityServices = Object.assign(services, {
      async findDecision(decisionInput: { repositoryId?: string; pullNumber: number }) {
        if (decisionInput.pullNumber !== changeRequest.number) return null;
        return findDecision();
      },
      async fetchPullRequest(_job?: HumanReviewPolicyJobPayload) {
        const state = await applicationServices.provider.fetchChangeRequestState(message);
        return { state: state.state, headSha: state.currentHeadRevision };
      },
      async fetchReviews(_job?: HumanReviewPolicyJobPayload) {
        return createAdapter(await requester()).listPullRequestReviews({ pullRequest: pullRequestRef() });
      },
      async updateCheck(check: {
        decision: Awaited<ReturnType<typeof findDecision>> extends infer T ? NonNullable<T> : never;
        state: "in_progress" | "success" | "failure";
        summary: string;
      }) {
        await applicationServices.provider.updatePolicyCheck({
          decision: {
            decisionId: check.decision.decisionId,
            workspaceId: message.workspaceId,
            repository,
            changeRequestId: changeRequest.externalId,
            changeRequestNumber: check.decision.pullNumber,
            headRevision: check.decision.headSha,
            mode: check.decision.mode,
            action: check.decision.action,
            selectedActors: check.decision.selectedReviewers,
            ...(check.decision.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: check.decision.requiredApprovalCount }),
            policyCheckRunId: check.decision.policyCheckRunId,
            policyCheckState: check.decision.policyCheckState,
          },
          state: check.state,
          summary: check.summary,
        });
      },
      async persistState(state: { decisionId: string; state: "in_progress" | "success" | "failure" }) {
        await applicationServices.decisions.persistState({ workspaceId: message.workspaceId, ...state });
      },
    });
    return compatibilityServices;
  };
}

async function findKnownRepository(
  db: DatabaseClient,
  message: Pick<RoutingJobMessage, "workspaceId" | "providerConnectionId" | "changeRequest"> | HumanReviewPolicyJobPayload,
): Promise<KnownRepository> {
  const repository = await db
    .selectFrom("repositories")
    .innerJoin("provider_connections", (join) => join
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id"))
    .select([
      "repositories.id as repositoryId",
      "provider_connections.external_connection_id as externalConnectionId",
    ])
    .where("repositories.workspace_id", "=", message.workspaceId)
    .where((eb) => eb.and([
      eb("repositories.provider", "=", message.changeRequest.repository.provider),
      eb("repositories.external_repository_id", "=", message.changeRequest.repository.externalId),
    ]))
    .where((eb) => eb.and([
      eb("provider_connections.id", "=", message.providerConnectionId),
      eb("provider_connections.provider", "=", message.changeRequest.repository.provider),
      eb("provider_connections.status", "=", "active"),
    ]))
    .executeTakeFirst();
  if (!repository) {
    throw new Error(`repository ${message.changeRequest.repository.externalId} is not known`);
  }
  return repository;
}

interface KnownRepository {
  repositoryId: string;
  externalConnectionId: string;
}

async function findRecordedPolicyCheckRunId(
  db: DatabaseClient,
  workspaceId: string,
  decisionId: string,
  headSha: string,
): Promise<string | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select(["policy_check_run_id as checkRunId", "head_sha as headSha"])
    .where((eb) => eb.and([eb("workspace_id", "=", workspaceId), eb("id", "=", decisionId)]))
    .executeTakeFirst();
  if (!decision || decision.headSha !== headSha) return null;
  return decision.checkRunId;
}

async function findDecisionIdForDelivery(
  db: DatabaseClient,
  workspaceId: string,
  deliveryId: string,
  headSha: string,
): Promise<string | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select(["id as decisionId", "head_sha as headSha"])
    .where((eb) => eb.and([eb("workspace_id", "=", workspaceId), eb("delivery_id", "=", deliveryId)]))
    .executeTakeFirst();
  return decision?.headSha === headSha ? decision.decisionId : null;
}

async function findPolicyCheckDecision(
  db: DatabaseClient,
  input: {
    workspaceId: string;
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
    .where((eb) => eb.and([
      eb("workspace_id", "=", input.workspaceId),
      eb("id", "=", input.decisionId),
    ]))
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
  workspaceId: string;
  adapter: GitHubAdapter;
  checkRun: { owner: string; repo: string; headSha: string };
  decisionId: string;
  appId: number;
  state: "in_progress" | "success" | "failure";
  summary: string;
}): Promise<string> {
  const recordedCheckRunId = await findRecordedPolicyCheckRunId(
    input.db,
    input.workspaceId,
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
    await recordPolicyCheck(input.db, input.workspaceId, {
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
  await recordPolicyCheck(input.db, input.workspaceId, {
    decisionId: input.decisionId,
    checkRunId: created.checkRunId,
    state: input.state,
  });
  return created.checkRunId;
}


function toChangedFile(file: unknown): ChangedFileMetadata {
  return {
    path: readString(file, "filename"),
    additions: readNumber(file, "additions"),
    deletions: readNumber(file, "deletions"),
  };
}

function toReviewMetadata(review: {
  userLogin: string;
  userType?: string;
  state: string;
  submittedAt: string | null;
}): ReviewMetadata {
  const actorType = review.userType === undefined || review.userType === "User" ? "human" : "bot";
  return {
    actor: review.userLogin,
    actorType,
    state: review.state.toLowerCase(),
    submittedAt: review.submittedAt,
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

function toSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error("GitHub ID must be a safe decimal integer");
  }
  return parsed;
}
