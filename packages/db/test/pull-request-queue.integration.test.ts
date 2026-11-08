import { describe, expect, it } from "vitest";
import { queuePullRequestKey } from "@triagepilot/contracts";
import { assertPullRequestQueueScopeActive, readQueueAssessments, resolvePullRequestQueueScope } from "../src/pull-request-queue";
import { queuePull } from "../../../test/pull-request-queue-fixtures";
import { withPostgresTestDatabase } from "./postgres";

type Db = Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0];
async function seed(db: Db, key: string) {
  const workspace = await db.insertInto("workspaces").values({ external_key: key }).returning("id").executeTakeFirstOrThrow();
  const connection = await db.insertInto("provider_connections").values({ workspace_id: workspace.id, provider: "github", external_connection_id: key, workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
  const repo = async (externalId: string) => db.insertInto("repositories").values({ workspace_id: workspace.id, provider: "github", provider_connection_id: connection.id, external_repository_id: externalId, owner: "acme", name: externalId, default_branch: "main", config_state: "valid" }).returning("id").executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, connectionId: connection.id, repo };
}
async function decision(db: Db, workspaceId: string, repositoryId: string, key: string, date: string, status: "succeeded" | "failed", number = 7) {
  await db.insertInto("routing_decisions").values({ workspace_id: workspaceId, repository_id: repositoryId, delivery_id: key, routing_key: key, action: "request_human_review", risk_score: 1, selected_reviewer: "alice", selected_reviewers: JSON.stringify(["alice"]), no_human_reason: null, pull_number: number, change_request_id: String(number), head_sha: key, mode: "shadow", action_status: status, action_error: status === "failed" ? "secret error" : null, details: { risk: { tier: "medium" }, routing: { requestedReviewerCount: 1, selectedReviewers: ["alice"] } }, effective_config_hash: key, inheritance_mode: "legacy", created_at: new Date(date) }).execute();
}
const ref = (externalId: string) => ({ provider: "github" as const, externalId, owner: "acme", name: externalId });
const counts = async (db: Db) => Promise.all(["repositories", "routing_decisions", "jobs"].map(async table => (await db.selectFrom(table as "repositories").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow()).count));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("pull request queue scope", () => {
  it("returns latest facts across repositories and retained history without writes", async () => withPostgresTestDatabase(async db => {
    const local = await seed(db, "local"), foreign = await seed(db, "foreign");
    const api = await local.repo("api"), other = await local.repo("other"), foreignRepo = await foreign.repo("api");
    await decision(db, local.workspaceId, api.id, "success", "2026-01-01", "succeeded");
    await decision(db, local.workspaceId, api.id, "failure", "2026-01-02", "failed");
    await decision(db, local.workspaceId, other.id, "other", "2025-01-01", "succeeded");
    await decision(db, local.workspaceId, other.id, "tie-a", "2025-02-01", "succeeded", 9);
    await decision(db, local.workspaceId, other.id, "tie-b", "2025-02-01", "failed", 9);
    const tie = await db.selectFrom("routing_decisions").select(["id", "head_sha"]).where("repository_id", "=", other.id).where("pull_number", "=", 9).orderBy("id", "desc").executeTakeFirstOrThrow();
    await decision(db, foreign.workspaceId, foreignRepo.id, "foreign", "2027-01-01", "succeeded");
    const before = await counts(db);
    const scope = await resolvePullRequestQueueScope(db, local.workspaceId, { githubOrganization: "ACME" });
    const facts = await readQueueAssessments(db, scope, [queuePull({ repository: ref("api"), number: 7 }), queuePull({ repository: ref("other"), number: 7 }), queuePull({ repository: ref("new"), number: 8 }), queuePull({ repository: ref("other"), number: 9 })]);
    expect(facts.get(queuePullRequestKey(ref("api"), 7))).toMatchObject({ actionStatus: "failed", headRevision: "failure", requiredReviews: 1 });
    expect(facts.get(queuePullRequestKey(ref("other"), 7))?.headRevision).toBe("other");
    expect(facts.get(queuePullRequestKey(ref("other"), 9))?.headRevision).toBe(tie.head_sha);
    expect(facts.get(queuePullRequestKey(ref("api"), 7))?.selectedActors).toEqual(["alice"]);
    expect(facts.get(queuePullRequestKey(ref("api"), 7))?.failureReason).not.toContain("secret");
    expect(facts.has(queuePullRequestKey(ref("new"), 8))).toBe(false);
    expect(await counts(db)).toEqual(before);
  }));
  it("rejects copied or modified scopes, connection changes, tombstones, and membership changes", async () => withPostgresTestDatabase(async db => {
    const local = await seed(db, "local"); const repo = await local.repo("api");
    const resolve = () => resolvePullRequestQueueScope(db, local.workspaceId, { githubOrganization: "acme" });
    const scope = await resolve();
    await expect(assertPullRequestQueueScopeActive(db, { ...scope })).rejects.toThrow();
    scope.knownRepositories[0]!.repository.name = "tampered";
    await expect(assertPullRequestQueueScopeActive(db, scope)).rejects.toThrow();
    let valid = await resolve();
    await db.updateTable("provider_connections").set({ status: "suspended" }).where("id", "=", local.connectionId).execute();
    await expect(readQueueAssessments(db, valid, [])).rejects.toThrow();
    await db.updateTable("provider_connections").set({ status: "active" }).where("id", "=", local.connectionId).execute();
    await db.insertInto("provider_connection_revocations").values({ workspace_id: local.workspaceId, provider: "github", external_connection_id: "local", physical_connection_id: local.connectionId, revoked_at: new Date() }).execute();
    await expect(readQueueAssessments(db, valid, [])).rejects.toThrow();
    await db.deleteFrom("provider_connection_revocations").execute();
    await local.repo("added");
    await expect(readQueueAssessments(db, valid, [])).rejects.toThrow();
    valid = await resolve();
    await db.deleteFrom("repositories").where("id", "=", repo.id).execute();
    await expect(readQueueAssessments(db, valid, [])).rejects.toThrow();
  }));
});
