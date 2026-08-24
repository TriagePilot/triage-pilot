# Required Human Review Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a required TriagePilot GitHub App check that passes only when the routed human-review policy is satisfied for the current pull-request head.

**Architecture:** The web process accepts `pull_request_review` deliveries and enqueues a dedicated evaluation job. The worker owns review-state evaluation, persists one policy-check record per routing decision, and updates the GitHub App check. Routing continues to select at most two individual reviewers; the ruleset consumes the stable policy check alongside CodeRabbit and CI.

**Tech Stack:** TypeScript, Hono, Zod, PostgreSQL, Kysely, Octokit GitHub App installation tokens, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-21-required-human-review-policy-design.md`

## Global Constraints

- Keep `web`, one worker, and PostgreSQL as the only runtime components; do not add GitHub Actions, a scheduler, polling, user tokens, or provider-specific deployment material.
- Shadow mode makes no GitHub writes; only `mode: enforce` from trusted base configuration authorizes the check or reviewer request.
- Enforceable reviewer candidates are individual `@login` handles only; reject team syntax such as `@org/team` during configuration parsing.
- Retain at most two selected reviewers and persist the selected cohort as the audit source of truth.
- The required check name is exactly `triagepilot/human-review-policy`; use `in_progress` while approvals are outstanding and `success` or `failure` only when completed.
- An approval satisfies the policy only when it is the selected reviewer's latest review on the current head SHA.
- Add a new migration; do not mutate `0001_initial.sql` or `0002_selected_reviewers.sql`.
- Preserve all unrelated working-tree changes.

---

## File Structure

- `packages/config/src/index.ts` validates individual reviewer handles.
- `packages/config/test/config.test.ts` specifies the configuration contract.
- `packages/shared/src/index.ts` defines the review-evaluation job payload and check-name constant.
- `packages/db/migrations/0003_human_review_policy.sql` stores pull-request/head identifiers and policy-check state on routing decisions.
- `packages/db/src/kysely.ts` types the new columns; `packages/db/src/decisions.ts` persists and queries policy decisions.
- `packages/db/src/jobs.ts` accepts both routing and review-evaluation jobs.
- `apps/web/src/routes/webhooks.ts` validates `pull_request_review` payloads and enqueues evaluation work.
- `apps/web/src/runtime-services.ts` wires the new durable-delivery method.
- `packages/github/src/adapter.ts` lists reviews and creates/updates the policy check run.
- `apps/worker/src/review-policy.ts` is pure policy evaluation over a reviewer cohort, current SHA, and GitHub review data.
- `apps/worker/src/review-policy-processor.ts` loads a decision, reads GitHub state, applies the check state, and records outcomes.
- `apps/worker/src/runner.ts` dispatches both job types.
- `apps/worker/src/runtime-services.ts` creates the policy check during routing and builds services for evaluation jobs.
- Existing worker, web, DB, GitHub-adapter, and operations tests receive focused coverage; docs describe setup and rulesets.

### Task 1: Make individual reviewers the enforceable configuration contract

**Files:**

- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/test/config.test.ts`
- Modify: `docs/github-app/repository-configuration.md`

**Interfaces:**

- Produces: `parseTriagePilotConfig(source)` rejects every reviewer containing `/` with a diagnostic at the applicable ownership rule or fallback-reviewer array element.
- Consumed by: routing processing in Task 6; an invalid team target follows its existing no-write configuration-failure path.

- [x] **Step 1: Write failing parser tests for team handles in both configuration locations**

```ts
it.each([
  'ownership:\n  rules:\n    - paths: ["src/**"]\n      reviewers: ["@acme/security"]\n',
  'ownership:\n  fallback_reviewers: ["@acme/security"]\n',
])("rejects team reviewer handles", (ownership) => {
  const result = parseTriagePilotConfig(`version: 1\nmode: enforce\n${ownership}`);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics[0]?.message).toContain("individual GitHub user handle");
});
```

- [x] **Step 2: Run the focused parser test and verify it fails**

Run: `pnpm --filter @triagepilot/config test -- config.test.ts`

Expected: FAIL because the current schema permits `@organization/team`.

- [x] **Step 3: Narrow `reviewerHandleSchema` to individual handles and make its error actionable**

```ts
const reviewerHandleSchema = z.string().regex(/^@[A-Za-z0-9_.-]+$/, {
  message: "reviewer must be an individual GitHub user handle such as @sasha; teams are not supported",
});
```

- [x] **Step 4: Document the changed contract beside the YAML example**

State that routing and enforceable policy accept individual handles only, with a short valid example such as `@sasha`; remove the current assertion that organization team handles are accepted.

- [x] **Step 5: Run configuration tests**

Run: `pnpm --filter @triagepilot/config test -- config.test.ts`

Expected: PASS.

- [x] **Step 6: Commit the configuration contract**

```bash
git add packages/config/src/index.ts packages/config/test/config.test.ts docs/github-app/repository-configuration.md
git commit -m "feat: restrict routed reviewers to individual users"
```

### Task 2: Add durable policy-check state and review-evaluation job types

**Files:**

- Create: `packages/db/migrations/0003_human_review_policy.sql`
- Modify: `packages/db/src/kysely.ts`
- Modify: `packages/db/src/jobs.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/db/src/decisions.ts`
- Modify: `packages/db/test/schema.integration.test.ts`
- Modify: `packages/db/test/jobs.test.ts`
- Modify: `packages/db/test/decisions.integration.test.ts`

**Interfaces:**

- Produces: `HumanReviewPolicyJobPayload`, `HUMAN_REVIEW_POLICY_CHECK_NAME`, and DB operations `recordPolicyCheck`, `findLatestHumanReviewPolicyDecision`, and `updatePolicyCheckState`.
- Consumed by: webhook ingestion in Task 3 and worker processing in Tasks 5 and 6.

- [x] **Step 1: Add failing DB tests for the data model and lookup**

Create one enforce-mode routing decision with `pullNumber: 7`, `headSha: "head-1"`, and `selectedReviewers: ["@alice", "@bob"]`; record its `in_progress` check with GitHub run ID `42`. Assert that lookup by repository and pull number returns that decision, its head, cohort, and run ID. Add a second decision for the same PR and assert the most recently created decision is returned.

- [x] **Step 2: Run the focused DB tests and verify they fail**

Run: `pnpm --filter @triagepilot/db test -- decisions.integration.test.ts schema.integration.test.ts jobs.test.ts`

Expected: FAIL because no policy columns, job type, or lookup operation exists.

- [x] **Step 3: Define shared types and the second job kind**

```ts
export const HUMAN_REVIEW_POLICY_CHECK_NAME = "triagepilot/human-review-policy";

export interface HumanReviewPolicyJobPayload {
  kind: "evaluate_human_review_policy";
  deliveryId: string;
  installationId: GitHubId;
  repositoryId: GitHubId;
  owner: string;
  repo: string;
  pullNumber: number;
}

export type TriagePilotJobPayload = RoutingJobPayload | HumanReviewPolicyJobPayload;
```

Change `JobKind` to the corresponding two-string union. Retain routing payload compatibility and keep the current job queue generic over `unknown` payloads.

- [x] **Step 4: Add migration `0003_human_review_policy.sql`**

Add nullable `pull_number integer`, `head_sha text`, `policy_check_run_id bigint`, and `policy_check_state text not null default 'not_started'` to `routing_decisions`. Add a check constraint limiting the state to `not_started`, `in_progress`, `success`, or `failure`, plus an index on `(repository_id, pull_number, created_at desc)` for policy-event lookup. Do not add `not null` constraints because prior decision rows exist.

- [x] **Step 5: Extend Kysely and decision persistence with exact policy methods**

Extend `RoutingDecisionsTable` with the four columns. Extend `DecisionInput` with required `pullNumber` and `headSha`, and persist them from routing jobs. Add:

```ts
export interface HumanReviewPolicyDecision {
  decisionId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  selectedReviewers: string[];
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
}

export async function recordPolicyCheck(
  db: Kysely<Database>,
  input: { decisionId: string; checkRunId: string; state: "in_progress" | "success" | "failure" },
): Promise<void>;

export async function findLatestHumanReviewPolicyDecision(
  db: Kysely<Database>,
  input: { repositoryId: string; pullNumber: number },
): Promise<HumanReviewPolicyDecision | null>;

export async function updatePolicyCheckState(
  db: Kysely<Database>,
  input: { decisionId: string; state: "in_progress" | "success" | "failure" },
): Promise<void>;
```

Parse `selected_reviewers` defensively as a string array; do not infer the cohort from GitHub's requested-reviewer list.

- [x] **Step 6: Add a durable review-delivery enqueue operation**

In `packages/db/src/deliveries.ts`, add `acceptHumanReviewPolicyDelivery` that inserts the webhook receipt and an `evaluate_human_review_policy` job in one transaction. Use `review-policy:${deliveryId}` as the job idempotency key; return the same `{ inserted, jobId }` shape as routing delivery acceptance.

- [x] **Step 7: Run DB tests and the migration suite**

Run: `pnpm --filter @triagepilot/db test`

Expected: PASS, including migration/schema assertions and duplicate-delivery behavior.

- [x] **Step 8: Commit durable policy state**

```bash
git add packages/shared/src/index.ts packages/db
git commit -m "feat: persist human review policy checks"
```

### Task 3: Accept review webhooks without doing GitHub work in the request

**Files:**

- Modify: `apps/web/src/routes/webhooks.ts`
- Modify: `apps/web/src/runtime-services.ts`
- Modify: `apps/web/test/webhooks.test.ts`
- Modify: `apps/web/test/runtime-services.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**

- Consumes: `acceptHumanReviewPolicyDelivery` and `HumanReviewPolicyJobPayload` from Task 2.
- Produces: `WebhookServices.acceptHumanReviewPolicyDelivery` and support for GitHub's `pull_request_review` event.
- Consumed by: worker dispatch in Task 5.

- [x] **Step 1: Write failing webhook route tests**

Add a signed `pull_request_review` fixture with installation ID, organization repository, pull number, and review state. Assert that it calls:

```ts
expect(acceptHumanReviewPolicyDelivery).toHaveBeenCalledWith(
  expect.objectContaining({
    deliveryId: "delivery-review-1",
    eventName: "pull_request_review",
    payload: expect.objectContaining({ kind: "evaluate_human_review_policy", pullNumber: 7 }),
  }),
);
```

Also assert that an out-of-scope account is ignored and a duplicate returns `{ ok: true, duplicate: true }`.

- [x] **Step 2: Run the web webhook tests and verify they fail**

Run: `pnpm --filter @triagepilot/web test -- webhooks.test.ts runtime-services.test.ts`

Expected: FAIL because `pull_request_review` is currently unsupported.

- [x] **Step 3: Validate and route review webhook payloads**

Add a Zod schema requiring `installation.id`, `repository.id`, `repository.name`, `repository.owner.login/type`, `pull_request.number`, and `review.state`. Add `pull_request_review` to `isSupportedEvent`. After signature and organization verification, construct only the metadata needed for `HumanReviewPolicyJobPayload`; do not store review body, diff content, or raw payload.

- [x] **Step 4: Wire the DB operation through web runtime services and exports**

Expose the new DB function from `packages/db/src/index.ts`, add the service method to `WebhookServices`, and delegate to `acceptHumanReviewPolicyDelivery(input.db, delivery)` from `createWebRuntimeServices`.

- [x] **Step 5: Run focused web tests**

Run: `pnpm --filter @triagepilot/web test -- webhooks.test.ts runtime-services.test.ts`

Expected: PASS.

- [x] **Step 6: Commit webhook intake**

```bash
git add apps/web/src/routes/webhooks.ts apps/web/src/runtime-services.ts apps/web/test packages/db/src/index.ts
git commit -m "feat: enqueue human review policy evaluations"
```

### Task 4: Add GitHub adapter operations for reviews and the required check

**Files:**

- Modify: `packages/github/src/adapter.ts`
- Modify: `packages/github/test/adapter.test.ts`
- Modify: `packages/github/src/index.ts` if types are re-exported there

**Interfaces:**

- Produces: `listPullRequestReviews`, `createHumanReviewPolicyCheck`, and `updateHumanReviewPolicyCheck`.
- Consumed by: routing initialization in Task 6 and evaluation in Task 5.

- [x] **Step 1: Write failing adapter tests for an in-progress check, completion update, and review list**

Assert a human-review check is created with the exact name, decision external ID, and state:

```ts
expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/check-runs", expect.objectContaining({
  head_sha: "head-1",
  name: "triagepilot/human-review-policy",
  external_id: "decision-1",
  status: "in_progress",
  output: expect.objectContaining({ title: "TriagePilot human review policy" }),
}));
```

Assert completion uses `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` with `status: "completed"` and `conclusion: "success"` or `"failure"`. Assert review listing calls `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with pagination.

- [x] **Step 2: Run adapter tests and verify they fail**

Run: `pnpm --filter @triagepilot/github test -- adapter.test.ts`

Expected: FAIL because policy-check and review-list methods are absent.

- [x] **Step 3: Add narrow adapter types and methods**

```ts
export interface PullRequestReview {
  userLogin: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED" | string;
  commitId: string | null;
  submittedAt: string | null;
}

async listPullRequestReviews(input: { pullRequest: PullRequestRef }): Promise<PullRequestReview[]>;

async createHumanReviewPolicyCheck(input: {
  checkRun: CheckRunRef;
  decisionId: string;
  state: "in_progress" | "success" | "failure";
  summary: string;
}): Promise<{ checkRunId: string }>;

async updateHumanReviewPolicyCheck(input: {
  checkRun: CheckRunRef;
  checkRunId: string;
  state: "in_progress" | "success" | "failure";
  summary: string;
}): Promise<void>;
```

For `in_progress`, create a check with that status and no conclusion. Do not attempt to move a completed run back to in progress; each routing decision/head receives a new run. For success/failure creation, use `status: "completed"` and the matching conclusion. Safely ignore malformed review records rather than casting them into approvals.

- [x] **Step 4: Run GitHub package tests**

Run: `pnpm --filter @triagepilot/github test`

Expected: PASS.

- [x] **Step 5: Commit GitHub policy primitives**

```bash
git add packages/github/src packages/github/test/adapter.test.ts
git commit -m "feat: manage human review policy checks"
```

### Task 5: Evaluate a stored reviewer cohort against the current head

**Files:**

- Create: `apps/worker/src/review-policy.ts`
- Create: `apps/worker/src/review-policy-processor.ts`
- Create: `apps/worker/test/review-policy.test.ts`
- Create: `apps/worker/test/review-policy-processor.test.ts`
- Modify: `apps/worker/src/runner.ts`
- Modify: `apps/worker/test/runner.test.ts`

**Interfaces:**

- Consumes: `HumanReviewPolicyDecision`, `PullRequestReview`, and the adapter methods from Tasks 2 and 4.
- Produces: pure `evaluateHumanReviewPolicy` and `processHumanReviewPolicyJob`.
- Consumed by: runtime service wiring in Task 6.

- [x] **Step 1: Write pure evaluation tests before implementation**

Cover these examples:

```ts
expect(evaluateHumanReviewPolicy({
  selectedReviewers: ["@alice", "@bob"],
  headSha: "head-2",
  reviews: [
    { userLogin: "alice", state: "APPROVED", commitId: "head-2", submittedAt: "2026-08-21T10:00:00Z" },
    { userLogin: "bob", state: "APPROVED", commitId: "head-1", submittedAt: "2026-08-21T11:00:00Z" },
  ],
})).toEqual({ state: "in_progress", missingReviewers: ["@bob"] });
```

Also test zero-reviewer no-human policy success, both reviewers approving, a latest `CHANGES_REQUESTED`, a dismissed approval, comment-only review, duplicate reviewer reviews where the newest wins, and case-insensitive GitHub login matching.

- [x] **Step 2: Run pure worker tests and verify they fail**

Run: `pnpm --filter @triagepilot/worker test -- review-policy.test.ts`

Expected: FAIL because the evaluation module does not exist.

- [x] **Step 3: Implement the pure evaluator with an explicit input type**

```ts
export type HumanReviewPolicyState = "in_progress" | "success" | "failure";

export function evaluateHumanReviewPolicy(input: {
  route: "no_human" | "human_review" | "no_eligible_reviewer";
  selectedReviewers: string[];
  headSha: string;
  reviews: PullRequestReview[];
}): { state: HumanReviewPolicyState; summary: string; missingReviewers: string[] };
```

Return `success` for `no_human`, `failure` for `no_eligible_reviewer`, and otherwise determine each selected reviewer's latest review on `headSha` by `submittedAt` (using response order only as a deterministic tie-breaker). A selected reviewer satisfies only with `APPROVED` on the current SHA.

- [x] **Step 4: Write failing processor tests for current-head safety and idempotency**

Mock a stored decision and GitHub client. Assert that the processor:

- skips without writing for no matching enforce decision;
- updates the stored check to `in_progress` while one approval is missing;
- re-reads the PR after evaluation and refuses a success write when `head.sha` changed;
- writes `success` and persists the state when all selected reviewers approved the matching head.

- [x] **Step 5: Implement `processHumanReviewPolicyJob`**

Define a narrow services interface:

```ts
export interface HumanReviewPolicyServices {
  findDecision(input: { repositoryId: string; pullNumber: number }): Promise<HumanReviewPolicyDecision | null>;
  fetchPullRequest(input: HumanReviewPolicyJobPayload): Promise<{ state: string; headSha: string }>;
  fetchReviews(input: HumanReviewPolicyJobPayload): Promise<PullRequestReview[]>;
  updateCheck(input: { decision: HumanReviewPolicyDecision; state: HumanReviewPolicyState; summary: string }): Promise<void>;
  persistState(input: { decisionId: string; state: HumanReviewPolicyState }): Promise<void>;
}
```

Only evaluate an open, enforce-mode decision. Compare the current head to `decision.headSha` before and immediately before a success update. If it changed, return without completing the old run; the synchronization routing event creates the new decision/check. Propagate GitHub failures so the existing worker retry and permanent-failure handling applies.

- [x] **Step 6: Dispatch the new job kind in `runWorkerOnce`**

Replace the single `processRoutingJob` branch with a discriminated dispatch that validates each payload separately and calls `processHumanReviewPolicyJob` for `evaluate_human_review_policy`. Keep unknown kinds as `PermanentJobError`.

- [x] **Step 7: Run worker unit tests**

Run: `pnpm --filter @triagepilot/worker test -- review-policy.test.ts review-policy-processor.test.ts runner.test.ts`

Expected: PASS.

- [x] **Step 8: Commit policy evaluation**

```bash
git add apps/worker/src/review-policy.ts apps/worker/src/review-policy-processor.ts apps/worker/src/runner.ts apps/worker/test
git commit -m "feat: evaluate required human approvals"
```

### Task 6: Create the policy check as part of enforce-mode routing and wire runtime services

**Files:**

- Modify: `apps/worker/src/processor.ts`
- Modify: `apps/worker/src/runtime-services.ts`
- Modify: `apps/worker/test/processor.test.ts`
- Modify: `apps/worker/test/runtime-services.test.ts`
- Modify: `apps/worker/test/runtime-services.integration.test.ts`

**Interfaces:**

- Consumes: policy persistence from Task 2, adapter methods from Task 4, and processor from Task 5.
- Produces: a policy check for every enforce-mode routing decision that is eligible for enforcement.
- Consumed by: users' GitHub rulesets.

- [x] **Step 1: Write failing routing-runtime tests for policy-check initialization**

Assert the enforce action sequence creates the policy check after the existing fresh-head guard and before the routing action is reported complete. Cover:

- `policy_approval` / no-human route → completed `success`;
- `request_human_review` with `@alice` → `in_progress` and reviewer request;
- `no_eligible_reviewer` on a human-review route → completed `failure` and no reviewer request;
- head mismatch → no policy check, comment, reviewer request, or policy approval.

- [x] **Step 2: Run focused worker runtime tests and verify they fail**

Run: `pnpm --filter @triagepilot/worker test -- processor.test.ts runtime-services.test.ts runtime-services.integration.test.ts`

Expected: FAIL because routing only writes the informational routing check.

- [x] **Step 3: Extend routing decision input with `pullNumber` and `headSha`**

In `processRoutingJob`, persist `pullNumber: message.pullNumber` and `headSha: message.headSha`. Preserve the existing action-status behavior; policy-check state is independent of action status.

- [x] **Step 4: Initialize the policy check through runtime services**

After verifying the current head, derive the route:

```ts
const route = action.action === "policy_approval"
  ? "no_human"
  : action.action === "no_eligible_reviewer"
    ? "no_eligible_reviewer"
    : "human_review";
```

Call the pure evaluator with an empty review list to obtain the initial state, create the App check with that state and summary, then call `recordPolicyCheck`. For a human-review route, request the individual reviewers after creating the in-progress check. Keep the informational routing check and routing comment unchanged.

- [x] **Step 5: Build `HumanReviewPolicyServices` in runtime services**

Use the existing installation requester and known-repository lookup. Implement current PR reads via `GET /repos/{owner}/{repo}/pulls/{pull_number}`, reviews via `GitHubAdapter.listPullRequestReviews`, DB lookup/persistence from Task 2, and check updates with the stored `policyCheckRunId`. Reuse one requester per job and do not add polling.

- [x] **Step 6: Run the full worker test package**

Run: `pnpm --filter @triagepilot/worker test`

Expected: PASS.

- [x] **Step 7: Commit routing integration**

```bash
git add apps/worker/src apps/worker/test
git commit -m "feat: publish human review policy checks"
```

### Task 7: Expose the operational state and complete public documentation

**Files:**

- Modify: `packages/db/src/operations.ts`
- Modify: `apps/web/src/runtime-services.ts`
- Modify: `apps/web/src/admin/App.tsx`
- Modify: `apps/web/test/operations.test.ts`
- Modify: `apps/web/test/runtime-services.test.ts`
- Modify: `apps/web/test/admin-app.test.tsx`
- Modify: `docs/github-app/permissions.md`
- Modify: `docs/github-app/setup.md`
- Modify: `docs/architecture.md`
- Modify: `docs/github-app/repository-configuration.md`
- Create: `docs/github-app/required-human-review-policy.md`

**Interfaces:**

- Consumes: persisted `policy_check_state` from Task 2.
- Produces: a dashboard-visible policy state and complete public setup/ruleset guidance.

- [x] **Step 1: Write failing operations projection and UI tests**

Extend the operation decision fixture with `policy_check_state: "in_progress"`. Assert the runtime projection includes `policyCheckState: "in_progress"` and the rendered dashboard contains a `Human review` column showing `Waiting for approval`. Add success and failure label assertions.

- [x] **Step 2: Run focused operations/UI tests and verify they fail**

Run: `pnpm --filter @triagepilot/web test -- operations.test.ts runtime-services.test.ts admin-app.test.tsx`

Expected: FAIL because the operations projection does not select policy state.

- [x] **Step 3: Add the policy state to the DB operation projection and dashboard**

Select `routing_decisions.policy_check_state`, normalize it as `"not_started" | "in_progress" | "success" | "failure"`, return it as `policyCheckState`, and render it separately from the existing action outcome. Keep the dashboard read-only and do not expose raw review bodies or credentials.

- [x] **Step 4: Write concise user-facing documentation**

Update permissions and setup instructions to add the `Pull request review` subscription. Update architecture and repository configuration to state individual-only reviewer targets and the check lifecycle. In `required-human-review-policy.md`, give this ruleset guidance:

```text
Require pull request before merging: required approvals = 0
Require status checks: triagepilot/human-review-policy (expected source: TriagePilot), CodeRabbit, and CI
Require conversation resolution: optional organization policy
```

Explain that TriagePilot never edits the ruleset, CodeRabbit and CI remain independent, and a no-eligible-reviewer failure blocks merge.

- [x] **Step 5: Run web tests**

Run: `pnpm --filter @triagepilot/web test`

Expected: PASS.

- [x] **Step 6: Commit operations and documentation**

```bash
git add packages/db/src/operations.ts apps/web docs/github-app docs/architecture.md
git commit -m "docs: explain required human review policy"
```

### Task 8: Verify the complete portable release boundary

**Files:**

- Modify only if verification exposes a defect: the smallest task-owned file above, with a focused regression test.

**Interfaces:**

- Consumes: all completed tasks.
- Produces: evidence that the monorepo, container image, migration path, and public boundary remain valid.

- [ ] **Step 1: Run formatting/type/static checks**

Run: `pnpm check`

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Build all workspace packages**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 4: Build the production container**

Run: `docker build .`

Expected: successful image build.

- [ ] **Step 5: Verify public packaging and migrations**

Run: `git diff --check`

Expected: no whitespace errors in the implementation worktree. Then inspect tracked files for private/provider material and run the repository's documented Gitleaks command before publishing. If a verification failure requires a fix, add its focused regression test and commit that test and its implementation file together with `git commit -m "fix: address human review policy verification"`; do not create an empty commit.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 establish the individual-only contract, durable cohort, check state, and idempotent job model. Tasks 3–6 cover review events, GitHub App checks, current-head evaluation, no-eligible failure, and worker boundaries. Task 7 covers dashboard and all required user documentation. Task 8 covers the prescribed release verification.
- **Placeholder scan:** No `TODO`, `TBD`, or deferred implementation placeholders remain.
- **Type consistency:** Both webhook and worker paths use `HumanReviewPolicyJobPayload`; policy checks use `HUMAN_REVIEW_POLICY_CHECK_NAME`; state is consistently `not_started | in_progress | success | failure` in persistence and `in_progress | success | failure` at evaluation time.
