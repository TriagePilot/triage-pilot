import { describe, expect, it, vi } from "vitest";
import type { HumanReviewPolicyDecision } from "@triagepilot/db";

import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
import { PermanentJobError } from "../src/errors";
import type { RoutingJobMessage } from "../src/processor";
import { processHumanReviewPolicyJob } from "../src/review-policy-processor";

const message: RoutingJobMessage = {
  kind: "process_pull_request",
  deliveryId: "delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  baseSha: "trusted-base-123",
  headSha: "unmerged-head-456",
  eventName: "pull_request.opened",
};

const policyMessage = {
  kind: "evaluate_human_review_policy" as const,
  deliveryId: "review-delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
};

describe("worker routing GitHub reads", () => {
  it("paginates changed files while preserving GitHub response order", async () => {
    const firstPage = [
      { filename: "src/first.ts", additions: 1, deletions: 0 },
      ...Array.from({ length: 98 }, () => ({ filename: "src/middle.ts", additions: 0, deletions: 0 })),
      { filename: "src/last.ts", additions: 2, deletions: 1 },
    ];
    const request = vi.fn(async (_route: string, parameters: Record<string, unknown>) => ({
      data: parameters.page === 1
        ? firstPage
        : [
            { filename: "src/after-first-page.ts", additions: 3, deletions: 0 },
            { filename: "src/after-last.ts", additions: 4, deletions: 2 },
          ],
    }));
    const services = buildServices(message, request);

    await expect(services.fetchChangedFiles(message)).resolves.toEqual([
      { path: "src/first.ts", additions: 1, deletions: 0 },
      ...Array.from({ length: 98 }, () => ({ path: "src/middle.ts", additions: 0, deletions: 0 })),
      { path: "src/last.ts", additions: 2, deletions: 1 },
      { path: "src/after-first-page.ts", additions: 3, deletions: 0 },
      { path: "src/after-last.ts", additions: 4, deletions: 2 },
    ]);
    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: "acme", repo: "api", pull_number: 7, page: 1, per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: "acme", repo: "api", pull_number: 7, page: 2, per_page: 100,
    });
  });

  it("reads repository configuration from the trusted base SHA without PR metadata lookup", async () => {
    const request = configRequester();
    const services = buildServices(message, request);

    await expect(services.fetchConfig(message)).resolves.toBe("version: 1\nmode: shadow\n");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "acme",
      repo: "api",
      path: ".github/triagepilot.yml",
      ref: "trusted-base-123",
    });
  });

  it("resolves a legacy queued payload through the current PR base and never the head SHA", async () => {
    const request = configRequester();
    const { baseSha: _baseSha, ...legacyMessage } = message;
    const services = buildServices(legacyMessage, request);

    await expect(services.fetchConfig(legacyMessage)).resolves.toBe("version: 1\nmode: shadow\n");

    expect(request.mock.calls).toEqual([
      ["GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "acme",
        repo: "api",
        pull_number: 7,
      }],
      ["GET /repos/{owner}/{repo}/contents/{path}", {
        owner: "acme",
        repo: "api",
        path: ".github/triagepilot.yml",
        ref: "trusted-base-123",
      }],
    ]);
  });

  it("blocks every enforce write when a delayed job no longer matches the current PR head", async () => {
    const request = actionRequester("advanced-head-789");
    const services = buildServices(message, request);

    await expect(
      services.applyDecisionActions({
        action: "policy_approval",
        decisionId: "decision-1",
        expectedHeadSha: "unmerged-head-456",
      }),
    ).rejects.toEqual(new PermanentJobError("pull request head changed before enforce actions"));

    expect(request.mock.calls).toEqual([
      ["GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "acme",
        repo: "api",
        pull_number: 7,
      }],
    ]);
  });

  it("applies enforce writes after a fresh matching head check", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "policy_approval",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
    });

    expect(request.mock.calls[0]).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner: "acme", repo: "api", pull_number: 7 },
    ]);
    expect(request.mock.calls.filter(([route]) => route.startsWith("POST ")).map(([route]) => route)).toEqual([
      "POST /repos/{owner}/{repo}/check-runs",
      "POST /repos/{owner}/{repo}/check-runs",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    ]);
    expect(request.mock.calls.find(
      ([route, parameters]) =>
        route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
    )).toEqual([
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "triagepilot/human-review-policy",
        head_sha: "unmerged-head-456",
        external_id: "decision-1",
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({ summary: "No human approval is required for this pull request." }),
      }),
    ]);
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      expect.objectContaining({ commit_id: "unmerged-head-456" }),
    );
  });

  it("creates an in-progress policy check before requesting selected reviewers", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      selectedReviewers: ["@alice"],
    });

    const policyCheckCall = request.mock.calls.findIndex(
      ([route, parameters]) => route.endsWith("/check-runs") && parameters.name === "triagepilot/human-review-policy",
    );
    const reviewerRequestCall = request.mock.calls.findIndex(([route]) => route.includes("requested_reviewers"));
    expect(policyCheckCall).toBeGreaterThan(0);
    expect(policyCheckCall).toBeLessThan(reviewerRequestCall);
    expect(request.mock.calls[policyCheckCall]?.[1]).toEqual(
      expect.objectContaining({ status: "in_progress" }),
    );
    expect(request.mock.calls[policyCheckCall]?.[1]).not.toHaveProperty("conclusion");
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      expect.objectContaining({ reviewers: ["alice"], team_reviewers: [] }),
    );
    expect(request.mock.calls.filter(([route]) => route.includes("requested_reviewers"))).toHaveLength(1);
  });

  it("creates a failed policy check without requesting reviewers when nobody is eligible", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request);

    await services.applyDecisionActions({
      action: "no_eligible_reviewer",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
    });

    expect(request.mock.calls[0]?.[0]).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        name: "triagepilot/human-review-policy",
        status: "completed",
        conclusion: "failure",
      }),
    );
    expect(request.mock.calls.some(([route]) => route.includes("requested_reviewers"))).toBe(false);
    expect(request.mock.calls.some(([route]) => route.endsWith("/reviews") && route.startsWith("POST "))).toBe(false);
  });

  it("reuses the recorded policy check for a retried decision on the same head", async () => {
    const request = actionRequester("unmerged-head-456");
    const services = buildServices(message, request, knownRepositoryDatabase("71"));

    await services.applyDecisionActions({
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      selectedReviewers: ["@alice"],
    });

    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(0);
    expect(request.mock.calls.filter(([route]) => route.includes("requested_reviewers"))).toHaveLength(1);
  });

  it("recovers a decision-keyed policy check after GitHub create succeeds but DB recording fails", async () => {
    const request = recoverablePolicyCheckRequester();
    const db = policyStateDatabase({ failFirstRecord: true });
    const services = buildServices(message, request, db);
    const action = {
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      selectedReviewers: ["@alice"],
    };

    await expect(services.applyDecisionActions(action)).rejects.toThrow("database record failed");
    await services.applyDecisionActions(action);

    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(1);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });
  });

  it("replaces a completed success check when an approval is withdrawn on the same head", async () => {
    const request = replacementPolicyRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "success" });
    const services = buildPolicyServices(request, db);
    const decision = humanReviewDecision({ policyCheckRunId: "71", policyCheckState: "success" });

    await processHumanReviewPolicyJob(policyMessage, {
      ...services,
      findDecision: async () => decision,
    });

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/check-runs",
      expect.objectContaining({
        external_id: "decision-1",
        status: "in_progress",
        output: expect.objectContaining({ summary: "Waiting for approval from @alice." }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
  });

  it("reconciles remote success when DB success persistence failed before a later withdrawal", async () => {
    const request = stalePersistencePolicyRequester();
    const db = policyStateDatabase({
      checkRunId: "71",
      state: "in_progress",
      failFirstStatePersist: true,
    });
    const services = buildPolicyServices(request, db);
    const staleDecision = humanReviewDecision({ policyCheckRunId: "71", policyCheckState: "in_progress" });
    const processingServices = { ...services, findDecision: async () => staleDecision };

    await expect(processHumanReviewPolicyJob(policyMessage, processingServices)).rejects.toThrow(
      "database state persistence failed",
    );
    expect(request.remoteCheck()).toEqual({ checkRunId: "71", state: "success" });
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });

    request.withdrawApproval();
    await processHumanReviewPolicyJob(policyMessage, processingServices);

    expect(request.remoteCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "in_progress" });
    expect(
      request.mock.calls.filter(
        ([route, parameters]) =>
          route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["informational check", "routing_check", "request_human_review"],
    ["routing comment", "comment", "request_human_review"],
    ["reviewer request", "reviewer", "request_human_review"],
    ["policy approval", "approval", "policy_approval"],
  ] as const)("fails the policy check when the later %s write fails permanently", async (_name, failurePoint, action) => {
    const request = permanentlyFailingActionRequester(failurePoint);
    const db = policyStateDatabase();
    const services = buildServices(message, request, db);

    await expect(
      services.applyDecisionActions({
        action,
        decisionId: "decision-1",
        expectedHeadSha: "unmerged-head-456",
        ...(action === "request_human_review" ? { selectedReviewers: ["@alice"] } : {}),
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("routing action failed") }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("fails the recorded policy run when a transient downstream error exhausts retries", async () => {
    const request = transientlyFailingActionRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "in_progress" });
    const services = buildServices(message, request, db);
    const action = {
      action: "request_human_review",
      decisionId: "decision-1",
      expectedHeadSha: "unmerged-head-456",
      selectedReviewers: ["@alice"],
    };

    await expect(services.applyDecisionActions(action)).rejects.toMatchObject({ status: 503 });
    await services.failPolicyCheck?.(
      "TriagePilot routing action failed after 5 attempts: GitHub temporarily unavailable",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("after 5 attempts") }),
      }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("recovers the exact delivery decision when policy finalization runs in a fresh service", async () => {
    const request = transientlyFailingActionRequester();
    const db = policyStateDatabase({ checkRunId: "71", state: "in_progress" });
    const recoveredServices = buildServices(message, request, db);

    await recoveredServices.failPolicyCheck?.(
      "TriagePilot routing action failed after 5 attempts: GitHub temporarily unavailable",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({ check_run_id: "71", conclusion: "failure" }),
    );
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("wires policy-event reads and terminal updates through one installation requester", async () => {
    const request = policyRequester();
    const createRequester = vi.fn(async () => ({ request })) as never;
    const services = createWorkerHumanReviewPolicyServiceFactory({
      db: knownRepositoryDatabase() as never,
      github: { appId: "123", privateKey: "test-private-key" },
      createRequester,
    })({
      kind: "evaluate_human_review_policy",
      deliveryId: "review-delivery-1",
      installationId: "99",
      repositoryId: "101",
      owner: "acme",
      repo: "api",
      pullNumber: 7,
    });
    const decision: HumanReviewPolicyDecision = {
      decisionId: "decision-1",
      owner: "acme",
      repo: "api",
      pullNumber: 7,
      headSha: "unmerged-head-456",
      mode: "enforce",
      action: "request_human_review",
      selectedReviewers: ["@alice"],
      policyCheckRunId: "71",
      policyCheckState: "in_progress",
    };

    await expect(services.fetchPullRequest({} as never)).resolves.toEqual({
      state: "open",
      headSha: "unmerged-head-456",
    });
    await expect(services.fetchReviews({} as never)).resolves.toEqual([
      {
        userLogin: "alice",
        state: "APPROVED",
        commitId: "unmerged-head-456",
        submittedAt: "2026-08-21T10:00:00Z",
      },
    ]);
    await services.updateCheck({ decision, state: "success", summary: "Approved." });

    expect(createRequester).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({ check_run_id: "71", conclusion: "success" }),
    );
  });

  it("finalizes the stored evaluation policy check through a fresh installation requester", async () => {
    const request = policyRequester();
    const db = evaluationPolicyDatabase();
    const services = buildPolicyServices(request, db);

    await services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    );

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: "71",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.stringContaining("evaluation failed") }),
      }),
    );
    expect(db.policyCheckState()).toBe("failure");
  });

  it("reconciles a remotely failed check before a later approval after failure persistence was interrupted", async () => {
    const request = partialStateRaceRequester({ initialState: "in_progress", reviewState: "APPROVED" });
    const db = evaluationPolicyDatabase({ failFirstRecord: true });
    const services = buildPolicyServices(request, db);

    await expect(services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    )).rejects.toThrow("database record failed");
    expect(request.runs()).toEqual([{ checkRunId: "71", state: "failure" }]);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "in_progress" });

    await expect(processHumanReviewPolicyJob(policyMessage, services)).rejects.toEqual(
      new PermanentJobError("human-review policy check is already failed"),
    );

    expect(request.runs()).toEqual([{ checkRunId: "71", state: "failure" }]);
    expect(request.mock.calls.filter(
      ([route, parameters]) => route.startsWith("PATCH ") && parameters.conclusion === "success",
    )).toHaveLength(0);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "failure" });
  });

  it("finalizes the newest replacement check after its DB recording was interrupted", async () => {
    const request = partialStateRaceRequester({ initialState: "success", reviewState: "CHANGES_REQUESTED" });
    const db = evaluationPolicyDatabase({ initialState: "success", failFirstRecord: true });
    const services = buildPolicyServices(request, db);

    await expect(processHumanReviewPolicyJob(policyMessage, services)).rejects.toThrow("database record failed");
    expect(request.runs()).toEqual([
      { checkRunId: "71", state: "success" },
      { checkRunId: "72", state: "in_progress" },
    ]);
    expect(db.policyCheck()).toEqual({ checkRunId: "71", state: "success" });

    await services.failPolicyCheck?.(
      "TriagePilot human-review policy evaluation failed: permission denied",
      "decision-1",
    );

    expect(request.runs()).toEqual([
      { checkRunId: "71", state: "success" },
      { checkRunId: "72", state: "failure" },
    ]);
    expect(request.mock.calls.filter(
      ([route, parameters]) => route.startsWith("PATCH ") && parameters.check_run_id === "71",
    )).toHaveLength(0);
    expect(db.policyCheck()).toEqual({ checkRunId: "72", state: "failure" });
  });
});

function configRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          base: { sha: "trusted-base-123" },
          head: { sha: "unmerged-head-456", ref: "unsafe-policy-change" },
          user: { login: "priya" },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const source = parameters.ref === "trusted-base-123"
        ? "version: 1\nmode: shadow\n"
        : "version: 1\nmode: enforce\n";
      return { data: { content: Buffer.from(source).toString("base64") } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function actionRequester(currentHeadSha: string) {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          base: { sha: "trusted-base-123" },
          head: { sha: currentHeadSha, ref: "feature" },
          user: { login: "priya" },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return { data: { check_runs: [] } };
    }
    if (
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    ) {
      return { data: [] };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 71 } };
    }
    if (route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function policyRequester() {
  return vi.fn(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "alice" },
          state: "APPROVED",
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T10:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "in_progress",
            conclusion: null,
            app: { id: 123 },
          }],
        },
      };
    }
    if (route.startsWith("PATCH ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function partialStateRaceRequester(input: {
  initialState: "in_progress" | "success";
  reviewState: "APPROVED" | "CHANGES_REQUESTED";
}) {
  const runs: Array<{ checkRunId: string; state: "in_progress" | "success" | "failure" }> = [{
    checkRunId: "71",
    state: input.initialState,
  }];
  const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "alice" },
          state: input.reviewState,
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: runs.map((run) => ({
            id: Number(run.checkRunId),
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: run.state === "in_progress" ? "in_progress" : "completed",
            conclusion: run.state === "in_progress" ? null : run.state,
            app: { id: 123 },
          })),
        },
      };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      runs.push({ checkRunId: "72", state: "in_progress" });
      return { data: { id: 72 } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      const run = runs.find(({ checkRunId }) => checkRunId === String(parameters.check_run_id));
      if (!run) throw new Error(`unknown check run ${String(parameters.check_run_id)}`);
      run.state = String(parameters.conclusion) as "success" | "failure";
      return { data: {} };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
  return Object.assign(request, {
    runs: () => runs.map((run) => ({ ...run })),
  });
}

function recoverablePolicyCheckRequester() {
  let created = false;
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      if (parameters.check_name === "triagepilot/human-review-policy") {
        return {
          data: {
            check_runs: created
              ? [{
                  id: 71,
                  name: "triagepilot/human-review-policy",
                  external_id: "decision-1",
                  status: "in_progress",
                  conclusion: null,
                  app: { id: 123 },
                }]
              : [],
          },
        };
      }
      return { data: { check_runs: [] } };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      created = true;
      return { data: { id: 71 } };
    }
    if (
      route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    ) return { data: [] };
    if (route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function replacementPolicyRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "alice" },
          state: "CHANGES_REQUESTED",
          commit_id: "unmerged-head-456",
          submitted_at: "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "completed",
            conclusion: "success",
            app: { id: 123 },
          }],
        },
      };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 72 } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function stalePersistencePolicyRequester() {
  let approvalWithdrawn = false;
  let remoteCheck = { checkRunId: "71", state: "in_progress" as "in_progress" | "success" | "failure" };
  const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      return {
        data: [{
          user: { login: "alice" },
          state: approvalWithdrawn ? "CHANGES_REQUESTED" : "APPROVED",
          commit_id: "unmerged-head-456",
          submitted_at: approvalWithdrawn ? "2026-08-21T12:00:00Z" : "2026-08-21T11:00:00Z",
        }],
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return {
        data: {
          check_runs: [{
            id: Number(remoteCheck.checkRunId),
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: remoteCheck.state === "in_progress" ? "in_progress" : "completed",
            conclusion: remoteCheck.state === "in_progress" ? null : remoteCheck.state,
            app: { id: 123 },
          }],
        },
      };
    }
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      remoteCheck = { checkRunId: String(parameters.check_run_id), state: String(parameters.conclusion) as "success" };
      return { data: {} };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      remoteCheck = { checkRunId: "72", state: "in_progress" };
      return { data: { id: 72 } };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });
  return Object.assign(request, {
    withdrawApproval() {
      approvalWithdrawn = true;
    },
    remoteCheck() {
      return remoteCheck;
    },
  });
}

function permanentlyFailingActionRequester(failurePoint: "routing_check" | "comment" | "reviewer" | "approval") {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      if (parameters.check_name === "triagepilot/human-review-policy") return { data: { check_runs: [] } };
      if (failurePoint === "routing_check") throw Object.assign(new Error("routing check denied"), { status: 422 });
      return { data: { check_runs: [] } };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
      return { data: { id: 71 } };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      if (failurePoint === "comment") throw Object.assign(new Error("comment denied"), { status: 422 });
      return { data: [] };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers" && failurePoint === "reviewer") {
      throw Object.assign(new Error("reviewer request denied"), { status: 422 });
    }
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews" && failurePoint === "approval") {
      throw Object.assign(new Error("approval denied"), { status: 422 });
    }
    if (route.startsWith("PATCH ") || route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route}`);
  });
}

function transientlyFailingActionRequester() {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { head: { sha: "unmerged-head-456" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { check_runs: [] } };
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      throw Object.assign(new Error("GitHub temporarily unavailable"), { status: 503 });
    }
    if (route.startsWith("PATCH ") || route.startsWith("POST ")) return { data: {} };
    throw new Error(`unexpected GitHub route: ${route} ${JSON.stringify(parameters)}`);
  });
}

function humanReviewDecision(
  overrides: Partial<HumanReviewPolicyDecision> = {},
): HumanReviewPolicyDecision {
  return {
    decisionId: "decision-1",
    owner: "acme",
    repo: "api",
    pullNumber: 7,
    headSha: "unmerged-head-456",
    mode: "enforce",
    action: "request_human_review",
    selectedReviewers: ["@alice"],
    policyCheckRunId: "71",
    policyCheckState: "in_progress",
    ...overrides,
  };
}

function policyStateDatabase(input: {
  checkRunId?: string;
  state?: "in_progress" | "success" | "failure";
  failFirstRecord?: boolean;
  failFirstStatePersist?: boolean;
} = {}) {
  let policyCheck = input.checkRunId
    ? { checkRunId: input.checkRunId, state: input.state ?? "in_progress" }
    : null;
  let failRecord = input.failFirstRecord ?? false;
  let failStatePersist = input.failFirstStatePersist ?? false;
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: (columns: string[]) => ({
            where: () => ({
              executeTakeFirst: async () => columns.includes("id as decisionId")
                ? { decisionId: "decision-1", headSha: "unmerged-head-456" }
                : policyCheck
                  ? { checkRunId: policyCheck.checkRunId, headSha: "unmerged-head-456" }
                  : undefined,
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({ executeTakeFirst: async () => ({ id: "repository-row-1" }) }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          execute: async () => {
            if ("policy_check_run_id" in values) {
              if (failRecord) {
                failRecord = false;
                throw new Error("database record failed");
              }
              policyCheck = {
                checkRunId: String(values.policy_check_run_id),
                state: values.policy_check_state as "in_progress" | "success" | "failure",
              };
            } else if ("policy_check_state" in values && policyCheck) {
              if (failStatePersist) {
                failStatePersist = false;
                throw new Error("database state persistence failed");
              }
              policyCheck.state = values.policy_check_state as "in_progress" | "success" | "failure";
            }
          },
        }),
      }),
    }),
    policyCheck: () => policyCheck,
  };
}

function buildPolicyServices(
  request: { (route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> },
  db: unknown = policyStateDatabase(),
) {
  return createWorkerHumanReviewPolicyServiceFactory({
    db: db as never,
    github: { appId: "123", privateKey: "test-private-key" },
    createRequester: vi.fn(async () => ({ request })) as never,
  })(policyMessage);
}

function knownRepositoryDatabase(recordedCheckRunId?: string) {
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => recordedCheckRunId
                ? { checkRunId: recordedCheckRunId, headSha: "unmerged-head-456" }
                : undefined,
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({
                    executeTakeFirst: async () => ({ id: "repository-row-1" }),
                  }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => [] }) }),
    }),
  };
}

function evaluationPolicyDatabase(input: {
  initialState?: "in_progress" | "success" | "failure";
  failFirstRecord?: boolean;
} = {}) {
  let policyCheck = { checkRunId: "71", state: input.initialState ?? "in_progress" };
  let failRecord = input.failFirstRecord ?? false;
  return {
    selectFrom: (table: string) => table === "routing_decisions"
      ? {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                decisionId: "decision-1",
                repositoryId: "repository-row-1",
                pullNumber: 7,
                headSha: "unmerged-head-456",
                mode: "enforce",
                policyCheckRunId: policyCheck.checkRunId,
                policyCheckState: policyCheck.state,
              }),
            }),
          }),
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  orderBy: () => ({
                    executeTakeFirst: async () => ({
                      decisionId: "decision-1",
                      owner: "acme",
                      repo: "api",
                      pullNumber: 7,
                      headSha: "unmerged-head-456",
                      mode: "enforce",
                      action: "request_human_review",
                      selectedReviewers: ["@alice"],
                      policyCheckRunId: policyCheck.checkRunId,
                      policyCheckState: policyCheck.state,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }
      : ({
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                where: () => ({
                  where: () => ({ executeTakeFirst: async () => ({ id: "repository-row-1" }) }),
                }),
              }),
            }),
          }),
        }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          execute: async () => {
            if ("policy_check_run_id" in values) {
              if (failRecord) {
                failRecord = false;
                throw new Error("database record failed");
              }
              policyCheck = {
                checkRunId: String(values.policy_check_run_id),
                state: String(values.policy_check_state) as "in_progress" | "success" | "failure",
              };
            } else if ("policy_check_state" in values) {
              policyCheck.state = String(values.policy_check_state) as "in_progress" | "success" | "failure";
            }
          },
        }),
      }),
    }),
    policyCheckState: () => policyCheck.state,
    policyCheck: () => ({ ...policyCheck }),
  };
}

function buildServices(
  messageInput: RoutingJobMessage,
  request: { (route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> },
  db: unknown = knownRepositoryDatabase(),
) {
  return createWorkerRoutingServiceFactory({
    db: db as never,
    github: { appId: "123", privateKey: "test-private-key" },
    createRequester: vi.fn(async () => ({ request })) as never,
  })(messageInput);
}
