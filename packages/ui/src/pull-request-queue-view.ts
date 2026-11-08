import { queuePullRequestKey, type PullRequestQueueSnapshot, type QueueActor, type QueueGroup, type QueueItem, type QueuePullRequest } from "@triagepilot/contracts";

export interface PullRequestQueueFilters { personId: string | null; repositoryIds: string[]; query: string; group: QueueGroup | null; sort: "activity" | "created" | "risk" }
const order: QueueGroup[] = ["reviewers", "authors", "reviewer_gap", "policy_met", "other"];
export function matchedQueueRoles(pull: QueuePullRequest, personId: string): Array<"author" | "reviewer"> {
  const roles: Array<"author" | "reviewer"> = [];
  if (pull.author.type === "human" && pull.author.id === personId) roles.push("author");
  if (pull.requestedUsers.some((actor) => actor.type === "human" && actor.id === personId)) roles.push("reviewer");
  return roles;
}
function timestamp(value: string): number | null { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
function compareTime(a: string, b: string, descending: boolean): number {
  const left = timestamp(a), right = timestamp(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
}
function tie(a: QueueItem, b: QueueItem): number {
  const x = a.pullRequest.repository, y = b.pullRequest.repository;
  return x.provider.localeCompare(y.provider) || x.externalId.localeCompare(y.externalId) || a.pullRequest.number - b.pullRequest.number;
}
export function buildPullRequestQueueView(snapshot: PullRequestQueueSnapshot, filters: PullRequestQueueFilters): { groups: Array<{ group: QueueGroup; items: QueueItem[] }>; persons: QueueActor[]; filteredCount: number } {
  const persons = new Map<string, QueueActor>();
  for (const { pullRequest: pull } of snapshot.items) for (const person of [pull.author, ...pull.requestedUsers]) if (person.type === "human") persons.set(person.id, person);
  const unique = new Map<string, QueueItem>();
  for (const item of snapshot.items) unique.set(queuePullRequestKey(item.pullRequest.repository, item.pullRequest.number), item);
  const query = filters.query.trim().toLocaleLowerCase();
  const items = [...unique.values()].filter(({ pullRequest: pull, attention }) => (!filters.personId || matchedQueueRoles(pull, filters.personId).length > 0) && (!filters.repositoryIds.length || filters.repositoryIds.includes(pull.repository.externalId)) && (!filters.group || filters.group === attention.group) && (!query || `${pull.title} ${pull.number} ${pull.repository.owner}/${pull.repository.name}`.toLocaleLowerCase().includes(query)));
  const risk = { high: 3, medium: 2, low: 1 };
  items.sort((a, b) => {
    const result = filters.sort === "activity" ? compareTime(a.pullRequest.updatedAt, b.pullRequest.updatedAt, false) : filters.sort === "created" ? compareTime(a.pullRequest.createdAt, b.pullRequest.createdAt, true) : (risk[b.assessment?.riskTier ?? "low"] * (b.assessment?.riskTier ? 1 : 0) - risk[a.assessment?.riskTier ?? "low"] * (a.assessment?.riskTier ? 1 : 0));
    return result || tie(a, b);
  });
  return { groups: order.map((group) => ({ group, items: items.filter((item) => item.attention.group === group) })), persons: [...persons.values()].sort((a, b) => a.login.localeCompare(b.login) || a.id.localeCompare(b.id)), filteredCount: items.length };
}
