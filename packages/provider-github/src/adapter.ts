import { App } from "@octokit/app";
import type {
  ConfigurationDocument,
  ConfigurationSource,
  RepositoryRef as ContractRepositoryRef,
  RiskTier,
  WorkspaceId,
} from "@triagepilot/contracts";

const PAGE_SIZE = 100;
const HUMAN_REVIEW_POLICY_CHECK_NAME = "triagepilot/human-review-policy";
const RISK_LABELS: Record<RiskTier, { name: string; color: string; description: string }> = {
  low: { name: "triagepilot:risk-low", color: "0e8a16", description: "TriagePilot risk: low" },
  medium: { name: "triagepilot:risk-medium", color: "fbca04", description: "TriagePilot risk: medium" },
  high: { name: "triagepilot:risk-high", color: "b60205", description: "TriagePilot risk: high" },
};

type Requester = {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
};

const CONFIGURATION_PATHS = [".triagepilot.yml", ".github/triagepilot.yml"] as const;

export class GitHubConfigurationSource implements ConfigurationSource {
  constructor(private readonly octokit: Requester) {}

  async loadOrganization(_workspaceId: WorkspaceId): Promise<null> {
    return null;
  }

  async loadRepository(input: {
    workspaceId: WorkspaceId;
    repository: ContractRepositoryRef;
    trustedRevision: string;
  }): Promise<ConfigurationDocument | null> {
    for (const path of CONFIGURATION_PATHS) {
      try {
        const response = await this.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner: input.repository.owner,
          repo: input.repository.name,
          path,
          ref: input.trustedRevision,
        });
        return {
          content: decodeGitHubContent(response.data),
          revision: input.trustedRevision,
          path,
        };
      } catch (error) {
        if (!isGitHubStatus(error, 404)) throw error;
      }
    }

    return null;
  }
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface PullRequestRef extends RepositoryRef {
  pullNumber: number;
}

export interface CheckRunRef extends RepositoryRef {
  headSha: string;
}

export interface PullRequestReview {
  userLogin: string;
  userType?: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED" | string;
  commitId: string | null;
  submittedAt: string | null;
}

export interface GitHubReviewerReplacementState {
  state: string;
  currentHeadRevision: string;
  authorActor: string;
  requestedActors: string[];
  reviews: Array<{
    actor: string;
    actorType: "human" | "bot";
    state: string;
    commitId: string | null;
    submittedAt: string | null;
  }>;
}

export interface ReviewerReplacementErrorClassification {
  kind: "permanent" | "retryable";
  message: string;
}

class GitHubReviewerReplacementProtocolError extends Error {}
class GitHubReviewerReplacementInputError extends Error {}

export async function createInstallationRequester(input: {
  appId: string;
  privateKey: string;
  installationId: number;
}): Promise<Requester> {
  const app = new App({ appId: input.appId, privateKey: input.privateKey });
  return app.getInstallationOctokit(input.installationId);
}

export class GitHubAdapter {
  constructor(private readonly octokit: Requester) {}

  async fetchDefaultBranchRevision(repository: ContractRepositoryRef): Promise<string> {
    const repositoryResponse = await this.octokit.request("GET /repos/{owner}/{repo}", {
      owner: repository.owner,
      repo: repository.name,
    });
    const defaultBranch = readRequiredString(repositoryResponse.data, "default_branch", "GitHub repository default branch");
    const commitResponse = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: repository.owner,
      repo: repository.name,
      ref: defaultBranch,
    });
    return readRequiredString(commitResponse.data, "sha", "GitHub default branch revision");
  }

  async inspectReviewerReplacement(input: {
    pullRequest: PullRequestRef;
  }): Promise<GitHubReviewerReplacementState> {
    const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...toPullParams(input.pullRequest),
    });
    if (!isRecord(response.data) || !isRecord(response.data.head) || !isRecord(response.data.user)) {
      throw new GitHubReviewerReplacementProtocolError("GitHub pull request replacement state is unavailable");
    }
    const state = readReviewerReplacementString(response.data, "state", "GitHub pull request state");
    const currentHeadRevision = readReviewerReplacementString(
      response.data.head,
      "sha",
      "GitHub pull request head revision",
    );
    const authorActor = normalizeGitHubActor(
      readReviewerReplacementString(response.data.user, "login", "GitHub pull request author"),
    );
    const requestedActors = await this.listRequestedReviewers(input);
    const reviews = (await this.listReviewerReplacementReviews(input)).map((review) => ({
      actor: normalizeGitHubActor(review.userLogin),
      actorType: review.userType === "Bot" ? "bot" as const : "human" as const,
      state: review.state.toLowerCase(),
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }));
    return { state, currentHeadRevision, authorActor, requestedActors, reviews };
  }

  async listRequestedReviewers(input: { pullRequest: PullRequestRef }): Promise<string[]> {
    const reviewers = new Set<string>();
    const response = await this.octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      toPullParams(input.pullRequest),
    );
    const users = readRequestedReviewerUsers(response.data);
    for (const user of users) {
      if (!isRecord(user) || typeof user.login !== "string" || user.login.trim().length === 0) {
        throw new GitHubReviewerReplacementProtocolError("GitHub requested reviewer user is malformed");
      }
      reviewers.add(normalizeGitHubActor(user.login));
    }
    return [...reviewers];
  }

  async reconcileReviewerReplacement(input: {
    pullRequest: PullRequestRef;
    unavailableActor: string;
    replacementActor: string;
  }): Promise<{ changed: boolean }> {
    const unavailableActor = normalizeGitHubIndividualActor(input.unavailableActor);
    const replacementActor = normalizeGitHubIndividualActor(input.replacementActor);
    if (unavailableActor === replacementActor) {
      throw new GitHubReviewerReplacementInputError("GitHub unavailable and replacement actors must differ");
    }
    const requestedBeforeRemoval = await this.listRequestedReviewers({ pullRequest: input.pullRequest });
    let changed = false;
    if (requestedBeforeRemoval.includes(unavailableActor)) {
      await this.octokit.request("DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...toPullParams(input.pullRequest),
        reviewers: [unavailableActor.slice(1)],
        team_reviewers: [],
      });
      changed = true;
    }
    const requestedBeforeAddition = await this.listRequestedReviewers({ pullRequest: input.pullRequest });
    if (!requestedBeforeAddition.includes(replacementActor)) {
      await this.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...toPullParams(input.pullRequest),
        reviewers: [replacementActor.slice(1)],
        team_reviewers: [],
      });
      changed = true;
    }
    return { changed };
  }

  classifyReviewerReplacementError(error: unknown): ReviewerReplacementErrorClassification {
    const message = error instanceof Error ? error.message : readOptionalString(error, "message") ?? "provider failed";
    const status = readOptionalNumber(error, "status");
    const retryableLimit = hasRetryableReviewerReplacementSignal(error, message);
    return {
      kind: error instanceof GitHubReviewerReplacementProtocolError
        || error instanceof GitHubReviewerReplacementInputError
        || (status !== null && [400, 401, 403, 404, 410, 422].includes(status) && !retryableLimit)
        ? "permanent"
        : "retryable",
      message,
    };
  }

  async upsertRoutingComment(input: { pullRequest: PullRequestRef; decisionId: string; body: string }) {
    const marker = decisionMarker(input.decisionId);
    const existing = await findPaginated(
      async (page) => {
        const comments = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          ...toIssueParams(input.pullRequest),
          page,
          per_page: PAGE_SIZE,
        });
        return Array.isArray(comments.data) ? comments.data : [];
      },
      (comment) => isCommentWithMarker(comment, marker),
    );
    const body = `${marker}\n${input.body}`;

    if (isCommentWithId(existing)) {
      await this.octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        ...toRepositoryParams(input.pullRequest),
        comment_id: existing.id,
        body,
      });
      return;
    }

    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...toIssueParams(input.pullRequest),
      body,
    });
  }

  async requestHumanReviewers(input: { pullRequest: PullRequestRef; reviewers: string[] }) {
    const handles = [...new Set(input.reviewers)].slice(0, 2).map((reviewer) => reviewer.replace(/^@/, ""));
    const reviewers = handles.filter((handle) => !handle.includes("/"));
    const teamReviewers = handles
      .filter((handle) => handle.includes("/"))
      .map((handle) => handle.slice(handle.indexOf("/") + 1));

    await this.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
      ...toPullParams(input.pullRequest),
      reviewers,
      team_reviewers: teamReviewers,
    });
  }

  async syncRiskLabel(input: { pullRequest: PullRequestRef; tier: RiskTier }) {
    const target = RISK_LABELS[input.tier];
    try {
      await this.octokit.request("POST /repos/{owner}/{repo}/labels", {
        ...toRepositoryParams(input.pullRequest),
        ...target,
      });
    } catch (error) {
      if (!isGitHubStatus(error, 422)) throw error;
    }

    const labels: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        ...toIssueParams(input.pullRequest),
        page,
        per_page: PAGE_SIZE,
      });
      const records = Array.isArray(response.data) ? response.data : [];
      labels.push(...records);
      if (records.length < PAGE_SIZE) break;
    }

    const managedNames = new Set(Object.values(RISK_LABELS).map((label) => label.name));
    for (const label of labels) {
      const name = readLabelName(label);
      if (name === undefined || name === target.name || !managedNames.has(name)) continue;
      await this.octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        ...toIssueParams(input.pullRequest),
        name,
      });
    }

    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      ...toIssueParams(input.pullRequest),
      labels: [target.name],
    });
  }

  async submitPolicyApproval(input: {
    pullRequest: PullRequestRef;
    expectedHeadSha: string;
    decisionId: string;
    body: string;
  }) {
    const marker = decisionMarker(input.decisionId);
    const existing = await findPaginated(
      async (page) => {
        const reviews = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
          ...toPullParams(input.pullRequest),
          page,
          per_page: PAGE_SIZE,
        });
        return Array.isArray(reviews.data) ? reviews.data : [];
      },
      (review) => hasBodyMarker(review, marker),
    );
    if (existing !== undefined) return;

    await this.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      ...toPullParams(input.pullRequest),
      commit_id: input.expectedHeadSha,
      event: "APPROVE",
      body: `${marker}\n${input.body}`,
    });
  }

  async listPullRequestReviews(input: { pullRequest: PullRequestRef }): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];

    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        ...toPullParams(input.pullRequest),
        page,
        per_page: PAGE_SIZE,
      });
      const records = Array.isArray(response.data) ? response.data : [];
      for (const record of records) {
        const review = readPullRequestReview(record, false);
        if (review !== undefined) reviews.push(review);
      }
      if (records.length < PAGE_SIZE) return reviews;
    }
  }

  private async listReviewerReplacementReviews(
    input: { pullRequest: PullRequestRef },
  ): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        ...toPullParams(input.pullRequest),
        page,
        per_page: PAGE_SIZE,
      });
      if (!Array.isArray(response.data)) {
        throw new GitHubReviewerReplacementProtocolError("GitHub pull request reviews response is malformed");
      }
      for (const record of response.data) reviews.push(readPullRequestReview(record, true));
      if (response.data.length < PAGE_SIZE) return reviews;
    }
  }

  async createHumanReviewPolicyCheck(input: {
    checkRun: CheckRunRef;
    decisionId: string;
    state: "in_progress" | "success" | "failure";
    summary: string;
  }): Promise<{ checkRunId: string }> {
    const response = await this.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      ...toRepositoryParams(input.checkRun),
      head_sha: input.checkRun.headSha,
      external_id: input.decisionId,
      ...humanReviewPolicyCheckPayload(input),
    });
    if (!isCheckRunWithId(response.data)) throw new Error("GitHub did not return a check run ID");
    return { checkRunId: String(response.data.id) };
  }

  async findHumanReviewPolicyCheck(input: {
    checkRun: CheckRunRef;
    decisionId: string;
    appId: number;
  }): Promise<{ checkRunId: string; state: "in_progress" | "success" | "failure" } | null> {
    const matches: Array<{ id: number | string; state: "in_progress" | "success" | "failure" }> = [];
    for (let page = 1; ; page += 1) {
      const checks = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ...toRepositoryParams(input.checkRun),
        ref: input.checkRun.headSha,
        check_name: HUMAN_REVIEW_POLICY_CHECK_NAME,
        app_id: input.appId,
        filter: "all",
        page,
        per_page: PAGE_SIZE,
      });
      const records = readCheckRuns(checks.data);
      for (const check of records) {
        if (!isCheckRunWithId(check) || !isHumanReviewPolicyCheckRun(check, input.decisionId, input.appId)) continue;
        const state = readHumanReviewPolicyCheckState(check);
        if (state !== null) matches.push({ id: check.id, state });
      }
      if (records.length < PAGE_SIZE) break;
    }

    const existing = matches.sort((left, right) => compareCheckRunIds(right.id, left.id))[0];
    if (!isCheckRunWithId(existing)) return null;
    return { checkRunId: String(existing.id), state: existing.state };
  }

  async updateHumanReviewPolicyCheck(input: {
    checkRun: CheckRunRef;
    checkRunId: string;
    state: "success" | "failure";
    summary: string;
  }): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      ...toRepositoryParams(input.checkRun),
      check_run_id: input.checkRunId,
      ...completedHumanReviewPolicyCheckPayload(input),
    });
  }

  async writeRoutingCheck(input: {
    checkRun: CheckRunRef;
    decisionId: string;
    conclusion: "success" | "neutral" | "failure";
    summary: string;
  }) {
    const existing = await findPaginated(
      async (page) => {
        const checks = await this.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
          ...toRepositoryParams(input.checkRun),
          ref: input.checkRun.headSha,
          check_name: "triagepilot/routing",
          filter: "all",
          page,
          per_page: PAGE_SIZE,
        });
        return readCheckRuns(checks.data);
      },
      (check) => isDecisionCheckRun(check, input.decisionId),
    );
    const check = {
      name: "triagepilot/routing",
      external_id: input.decisionId,
      status: "completed",
      conclusion: input.conclusion,
      output: {
        title: "TriagePilot routing",
        summary: input.summary,
      },
    };

    if (isCheckRunWithId(existing)) {
      await this.octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        ...toRepositoryParams(input.checkRun),
        check_run_id: existing.id,
        ...check,
      });
      return;
    }

    await this.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      ...toRepositoryParams(input.checkRun),
      head_sha: input.checkRun.headSha,
      ...check,
    });
  }
}

export function githubRepositoryUrl(repository: Pick<ContractRepositoryRef, "owner" | "name">): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

export function githubChangeRequestUrl(
  repository: Pick<ContractRepositoryRef, "owner" | "name">,
  changeRequestNumber: number,
): string {
  return `${githubRepositoryUrl(repository)}/pull/${changeRequestNumber}`;
}

function toRepositoryParams(ref: RepositoryRef) {
  return { owner: ref.owner, repo: ref.repo };
}

function toPullParams(ref: PullRequestRef) {
  return { ...toRepositoryParams(ref), pull_number: ref.pullNumber };
}

function toIssueParams(ref: PullRequestRef) {
  return { ...toRepositoryParams(ref), issue_number: ref.pullNumber };
}

function decisionMarker(decisionId: string): string {
  return `<!-- triagepilot:decision:${decisionId} -->`;
}

function isCommentWithMarker(comment: unknown, marker: string): comment is { body: string; id?: unknown } {
  return typeof comment === "object" && comment !== null && "body" in comment && String(comment.body).startsWith(marker);
}

function isCommentWithId(comment: unknown): comment is { id: number | string } {
  return typeof comment === "object" && comment !== null && "id" in comment;
}

function readLabelName(label: unknown): string | undefined {
  if (typeof label !== "object" || label === null || !("name" in label)) return undefined;
  const name = String(label.name).trim();
  return name || undefined;
}

function readRequiredString(value: unknown, key: string, label: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].trim().length === 0) {
    throw new Error(`${label} is unavailable`);
  }
  return value[key].trim();
}

function decodeGitHubContent(data: unknown): string {
  if (!isRecord(data) || typeof data.content !== "string") return "";
  return Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function isGitHubStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

function readCheckRuns(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null || !("check_runs" in data)) return [];
  return Array.isArray(data.check_runs) ? data.check_runs : [];
}

function isDecisionCheckRun(check: unknown, decisionId: string): boolean {
  return (
    typeof check === "object" &&
    check !== null &&
    "name" in check &&
    check.name === "triagepilot/routing" &&
    "external_id" in check &&
    check.external_id === decisionId
  );
}

function isHumanReviewPolicyCheckRun(check: unknown, decisionId: string, appId: number): boolean {
  return (
    isRecord(check) &&
    check.name === HUMAN_REVIEW_POLICY_CHECK_NAME &&
    check.external_id === decisionId &&
    isRecord(check.app) &&
    check.app.id === appId
  );
}

function compareCheckRunIds(left: number | string, right: number | string): number {
  const leftId = BigInt(String(left));
  const rightId = BigInt(String(right));
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function readHumanReviewPolicyCheckState(
  check: unknown,
): "in_progress" | "success" | "failure" | null {
  if (!isRecord(check)) return null;
  if (check.status !== "completed") return "in_progress";
  return check.conclusion === "success" || check.conclusion === "failure" ? check.conclusion : null;
}

function isCheckRunWithId(check: unknown): check is { id: number | string } {
  return typeof check === "object" && check !== null && "id" in check;
}

function humanReviewPolicyCheckPayload(input: {
  state: "in_progress" | "success" | "failure";
  summary: string;
}) {
  const check = {
    name: HUMAN_REVIEW_POLICY_CHECK_NAME,
    output: {
      title: "TriagePilot human review policy",
      summary: input.summary,
    },
  };
  if (input.state === "in_progress") return { ...check, status: "in_progress" as const };
  return { ...check, status: "completed" as const, conclusion: input.state };
}

function completedHumanReviewPolicyCheckPayload(input: { state: "success" | "failure"; summary: string }) {
  return {
    name: HUMAN_REVIEW_POLICY_CHECK_NAME,
    status: "completed" as const,
    conclusion: input.state,
    output: {
      title: "TriagePilot human review policy",
      summary: input.summary,
    },
  };
}

function readPullRequestReview(value: unknown, strict: true): PullRequestReview;
function readPullRequestReview(value: unknown, strict: false): PullRequestReview | undefined;
function readPullRequestReview(value: unknown, strict: boolean): PullRequestReview | undefined {
  if (
    !isRecord(value)
    || !isRecord(value.user)
    || typeof value.user.login !== "string"
    || typeof value.state !== "string"
    || value.user.login.trim().length === 0
    || value.state.trim().length === 0
  ) {
    if (strict) throw new GitHubReviewerReplacementProtocolError("GitHub pull request review is malformed");
    return undefined;
  }
  if (
    strict
    && (
      typeof value.user.type !== "string"
      || (value.user.type !== "User" && value.user.type !== "Bot")
      || !("commit_id" in value)
      || !("submitted_at" in value)
      || (typeof value.commit_id !== "string" && value.commit_id !== null)
      || (typeof value.submitted_at !== "string" && value.submitted_at !== null)
      || (typeof value.commit_id === "string" && value.commit_id.trim().length === 0)
      || (typeof value.submitted_at === "string" && value.submitted_at.trim().length === 0)
    )
  ) {
    throw new GitHubReviewerReplacementProtocolError("GitHub pull request review is malformed");
  }

  return {
    userLogin: value.user.login,
    ...(typeof value.user.type === "string" ? { userType: value.user.type } : {}),
    state: value.state,
    commitId: typeof value.commit_id === "string" ? value.commit_id : null,
    submittedAt: typeof value.submitted_at === "string" ? value.submitted_at : null,
  };
}

function readRequestedReviewerUsers(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    throw new GitHubReviewerReplacementProtocolError("GitHub requested reviewers response is malformed");
  }
  return value.users;
}

function readReviewerReplacementString(value: unknown, key: string, label: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].trim().length === 0) {
    throw new GitHubReviewerReplacementProtocolError(`${label} is unavailable`);
  }
  return value[key].trim();
}

function normalizeGitHubActor(value: string): string {
  const login = value.trim().replace(/^@/, "").toLowerCase();
  if (login.length === 0) throw new Error("GitHub actor login is unavailable");
  return `@${login}`;
}

function normalizeGitHubIndividualActor(value: string): string {
  let actor: string;
  try {
    actor = normalizeGitHubActor(value);
  } catch {
    throw new GitHubReviewerReplacementInputError("GitHub reviewer actor login is unavailable");
  }
  if (actor.includes("/")) {
    throw new GitHubReviewerReplacementInputError("GitHub reviewer actor must identify an individual user");
  }
  return actor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function readOptionalNumber(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : null;
}

function hasRetryableReviewerReplacementSignal(error: unknown, message: string): boolean {
  const status = readOptionalNumber(error, "status");
  if (status === 429) return true;
  if (status !== 403 && status !== 422) return false;
  const headers = isRecord(error) && isRecord(error.response) && isRecord(error.response.headers)
    ? error.response.headers
    : null;
  const retryAfter = readHeader(headers, "retry-after");
  const remaining = readHeader(headers, "x-ratelimit-remaining");
  const normalizedMessage = message.toLowerCase();
  return retryAfter !== null
    || remaining === "0"
    || normalizedMessage.includes("rate limit")
    || normalizedMessage.includes("secondary limit")
    || normalizedMessage.includes("abuse")
    || normalizedMessage.includes("spam")
    || normalizedMessage.includes("submitted too quickly");
}

function readHeader(headers: Record<string, unknown> | null, name: string): string | null {
  if (headers === null) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) {
      return String(value).trim();
    }
  }
  return null;
}

function hasBodyMarker(value: unknown, marker: string): boolean {
  return typeof value === "object" && value !== null && "body" in value && String(value.body).includes(marker);
}

async function findPaginated<T>(
  fetchPage: (page: number) => Promise<T[]>,
  predicate: (value: T) => boolean,
): Promise<T | undefined> {
  for (let page = 1; ; page += 1) {
    const values = await fetchPage(page);
    const match = values.find(predicate);
    if (match !== undefined) return match;
    if (values.length < PAGE_SIZE) return undefined;
  }
}
