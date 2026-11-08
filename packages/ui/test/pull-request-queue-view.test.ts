import { expect, it } from "vitest";
import type { QueueItem } from "@triagepilot/contracts";
import { queueAssessment, queuePull, queueReviewState, queueSnapshot } from "../../../test/pull-request-queue-fixtures.js";
import { buildPullRequestQueueView, matchedQueueRoles } from "../src/pull-request-queue-view.js";
const filters = { personId: null, repositoryIds: [], query: "", group: null, sort: "activity" } as const;
function item(number: number, extra: Partial<QueueItem> = {}): QueueItem { return { pullRequest: queuePull({ number }), reviewState: queueReviewState(), assessment: queueAssessment(), attention: { group: "reviewers", badge: "reviewers_move", reason: "Waiting", actorIds: [], teamIds: [], secondaryReasons: [], approvedCount: 0, requiredCount: 1, assessmentStatus: "current", checkUpdatePending: false }, links: { provider: "https://example.com", decision: null }, ...extra }; }
it("matches human author or outstanding individual request by stable id", () => {
  const pull = queuePull({ author: { id: "1", login: "Renamed", type: "human" }, requestedUsers: [{ id: "1", login: "OLD", type: "human" }, { id: "2", login: "robot", type: "bot" }] });
  expect(matchedQueueRoles(pull, "1")).toEqual(["author", "reviewer"]); expect(matchedQueueRoles(pull, "2")).toEqual([]);
  const snapshot = queueSnapshot({ items: [item(1, { pullRequest: pull }), item(2)] });
  expect(buildPullRequestQueueView(snapshot, { ...filters, query: "no match" }).persons.map((p) => p.id)).toEqual(["1"]);
});
it("orders groups, retains identical numbers in different repositories, and puts unknown dates and risk last", () => {
  const first = item(1, { pullRequest: queuePull({ number: 1, updatedAt: "bad" }), assessment: null });
  const second = item(1, { pullRequest: queuePull({ number: 1, repository: { provider: "github", externalId: "2", owner: "o", name: "r" }, updatedAt: "2020-01-01" }), assessment: queueAssessment({ riskTier: "high" }) });
  const view = buildPullRequestQueueView(queueSnapshot({ items: [first, second] }), filters);
  expect(view.groups.map((g) => g.group)).toEqual(["reviewers", "authors", "reviewer_gap", "policy_met", "other"]); expect(view.groups[0]?.items).toEqual([second, first]); expect(view.filteredCount).toBe(2);
  expect(buildPullRequestQueueView(queueSnapshot({ items: [first, second] }), { ...filters, sort: "risk" }).groups[0]?.items).toEqual([second, first]);
});
it("sorts created newest first, activity oldest first, and risk highest with deterministic ties", () => {
  const a = item(2, { pullRequest: queuePull({ number: 2, createdAt: "2022-01-01", updatedAt: "2021-01-01" }), assessment: queueAssessment({ riskTier: "medium" }) });
  const b = item(1, { pullRequest: queuePull({ number: 1, createdAt: "2023-01-01", updatedAt: "2022-01-01" }), assessment: queueAssessment({ riskTier: "high" }) });
  const c = item(3, { pullRequest: queuePull({ number: 3, createdAt: "invalid", updatedAt: "invalid" }), assessment: queueAssessment({ riskTier: "high" }) });
  const snapshot = queueSnapshot({ items: [c, a, b] });
  expect(buildPullRequestQueueView(snapshot, filters).groups[0]?.items).toEqual([a, b, c]);
  expect(buildPullRequestQueueView(snapshot, { ...filters, sort: "created" }).groups[0]?.items).toEqual([b, a, c]);
  expect(buildPullRequestQueueView(snapshot, { ...filters, sort: "risk" }).groups[0]?.items).toEqual([b, c, a]);
});
it("deduplicates identity and excludes historical reviewers and team-only targets", () => {
  const original = item(1, { reviewState: queueReviewState({ reviews: [{ id: "r", actor: { id: "history", login: "past", type: "human" }, state: "APPROVED", commitId: null, submittedAt: null }] }), pullRequest: queuePull({ requestedTeams: [{ id: "team", name: "team" }] }) });
  const snapshot = queueSnapshot({ items: [original, original] });
  expect(buildPullRequestQueueView(snapshot, filters).filteredCount).toBe(1);
  expect(buildPullRequestQueueView(snapshot, { ...filters, personId: "history" }).filteredCount).toBe(0);
  expect(buildPullRequestQueueView(snapshot, { ...filters, personId: "team" }).filteredCount).toBe(0);
  expect(buildPullRequestQueueView(snapshot, filters).persons.map((person) => person.id)).toEqual(["1"]);
});
