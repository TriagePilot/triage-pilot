import { readFile } from "node:fs/promises";
import type { DecisionEventV1 } from "@triagepilot/contracts";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createDatabase, persistDecisionWithEvent, runMigrations } from "../src";
import { withPostgresTestDatabaseUrl } from "./postgres";

const PRE_WORKSPACE_MIGRATIONS = [
  "0001_initial.sql",
  "0002_selected_reviewers.sql",
  "0003_human_review_policy.sql",
  "0004_semantic_routing_deduplication.sql",
] as const;
const FINAL_MIGRATIONS = [
  ...PRE_WORKSPACE_MIGRATIONS,
  "0005_reviewer_availability.sql",
  "0005_workspace_scope.sql",
  "0006_decision_outbox.sql",
  "0007_workspace_reviewer_availability.sql",
  "0008_reviewer_mutation_intents.sql",
  "0009_provider_connection_revocations.sql",
  "0010_provider_connection_preemptive_revocations.sql",
  "0011_reviewer_selection_context.sql",
  "0012_pull_request_projection.sql",
  "0013_queue_pull_checkpoints.sql",
  "0014_queue_verification.sql",
  "0015_queue_sync_schedule.sql",
  "0016_deferred_pull_request_deliveries.sql",
];

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("reviewer availability migration histories", () => {
  it("backfills origin only from retained receipt and job evidence", async () => {
    await withPostgresTestDatabaseUrl(async databaseUrl => {
      await applyMigrationHistory(databaseUrl, FINAL_MIGRATIONS.slice(0, FINAL_MIGRATIONS.indexOf("0012_pull_request_projection.sql")));
      const pool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const workspace = (await pool.query<{ id: string }>("select id from workspaces where external_key = 'self-hosted'")).rows[0]!.id;
        const connection = (await pool.query<{ id: string }>("insert into provider_connections (workspace_id, provider, external_connection_id, workspace_login, account_type, status, permissions) values ($1, 'github', 'new-install', 'acme', 'Organization', 'active', '{}') returning id", [workspace])).rows[0]!.id;
        const repository = (await pool.query<{ id: string }>("insert into repositories (workspace_id, provider, provider_connection_id, external_repository_id, owner, name) values ($1, 'github', $2, 'repo', 'acme', 'api') returning id", [workspace, connection])).rows[0]!.id;
        await pool.query("insert into webhook_receipts (workspace_id, provider, delivery_id, event_name, external_connection_id, payload_summary, created_at) values ($1, 'github', 'proved', 'pull_request', 'old-install', '{}', '2026-01-01')", [workspace]);
        await pool.query("insert into jobs (workspace_id, provider, provider_connection_id, kind, payload, idempotency_key, created_at) values ($1, 'github', $2, 'process_pull_request', $3, 'proved-key', '2026-01-02'), ($1, 'github', $2, 'process_pull_request', $4, 'unknown-key', '2026-01-02')", [workspace, connection, { deliveryId: "proved", changeRequest: { repository: { externalId: "repo" } } }, { deliveryId: "unknown", changeRequest: { repository: { externalId: "repo" } } }]);
        await pool.query("insert into jobs (workspace_id, provider, provider_connection_id, kind, status, locked_at, locked_by, payload, idempotency_key) values ($1, 'github', $2, 'process_pull_request', 'running', now(), 'old-worker', '{}', 'unknown-running'), ($1, 'github', $2, 'process_pull_request', 'succeeded', null, null, '{}', 'unknown-succeeded')", [workspace, connection]);
        await pool.query("insert into webhook_receipts (workspace_id, provider, delivery_id, event_name, external_connection_id, payload_summary, created_at) values ($1, 'github', 'policy-proved', 'pull_request_review', 'old-install', '{}', '2026-01-01')", [workspace]);
        await pool.query("insert into jobs (workspace_id, provider, provider_connection_id, kind, payload, idempotency_key, created_at) values ($1, 'github', $2, 'evaluate_human_review_policy', $3, 'policy-proved', '2026-01-02'), ($1, 'github', $2, 'evaluate_human_review_policy', $4, 'policy-unknown', '2026-01-02')", [workspace, connection, { deliveryId: "policy-proved", changeRequest: { repository: { externalId: "repo" } } }, { deliveryId: "policy-unknown", changeRequest: { repository: { externalId: "repo" } } }]);
        await pool.query("insert into routing_decisions (workspace_id, repository_id, delivery_id, routing_key, action, risk_score, details, effective_config_hash, inheritance_mode, created_at) values ($1, $2, 'proved', 'proved-key', 'route', 0, '{}', 'hash', 'legacy', '2026-01-03'), ($1, $2, 'unknown', 'unknown-key', 'route', 0, '{}', 'hash', 'legacy', '2026-01-03')", [workspace, repository]);
      } finally { await pool.end(); }
      await runMigrations(databaseUrl);
      const verification = new pg.Pool({ connectionString: databaseUrl });
      try {
        const result = await verification.query("select routing_key, origin_external_installation_id, origin_external_repository_id from routing_decisions order by routing_key");
        expect(result.rows).toEqual([{ routing_key: "proved-key", origin_external_installation_id: "old-install", origin_external_repository_id: "repo" }, { routing_key: "unknown-key", origin_external_installation_id: null, origin_external_repository_id: null }]);
        const routingJobs = await verification.query("select idempotency_key, status, external_installation_id, external_repository_id, locked_at, locked_by, last_error from jobs where kind = 'process_pull_request' order by idempotency_key");
        expect(routingJobs.rows).toEqual([
          { idempotency_key: "proved-key", status: "queued", external_installation_id: "old-install", external_repository_id: "repo", locked_at: null, locked_by: null, last_error: null },
          { idempotency_key: "unknown-key", status: "failed", external_installation_id: null, external_repository_id: null, locked_at: null, locked_by: null, last_error: "legacy routing job lacks immutable installation or repository provenance" },
          { idempotency_key: "unknown-running", status: "failed", external_installation_id: null, external_repository_id: null, locked_at: null, locked_by: null, last_error: "legacy routing job lacks immutable installation or repository provenance" },
          { idempotency_key: "unknown-succeeded", status: "succeeded", external_installation_id: null, external_repository_id: null, locked_at: null, locked_by: null, last_error: null },
        ]);
        const policyJobs = await verification.query("select idempotency_key, status, external_installation_id, external_repository_id, last_error from jobs where kind = 'evaluate_human_review_policy' order by idempotency_key");
        expect(policyJobs.rows).toEqual([{ idempotency_key: "policy-proved", status: "queued", external_installation_id: "old-install", external_repository_id: "repo", last_error: null }, { idempotency_key: "policy-unknown", status: "failed", external_installation_id: null, external_repository_id: null, last_error: "legacy policy job lacks immutable installation or repository provenance" }]);
      } finally { await verification.end(); }
    });
  }, 20_000);

  it("builds the workspace-scoped availability schema from a fresh database", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const verification = new pg.Pool({ connectionString: databaseUrl });
      try {
        await expect(appliedMigrations(verification)).resolves.toEqual(FINAL_MIGRATIONS);
        await expect(verification.query<{ external_key: string; timezone: string }>(`
          select workspaces.external_key, settings.timezone
          from workspace_operational_settings settings
          join workspaces on workspaces.id = settings.workspace_id
        `)).resolves.toMatchObject({ rows: [{ external_key: "self-hosted", timezone: "UTC" }] });
      } finally {
        await verification.end();
      }
    });
  }, 20_000);

  it("upgrades the current main history and preserves historical availability rows", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await applyMigrationHistory(databaseUrl, [
        ...PRE_WORKSPACE_MIGRATIONS,
        "0005_reviewer_availability.sql",
      ]);
      const setup = new pg.Pool({ connectionString: databaseUrl });
      let absenceId: string;
      let replacementId: string;
      let decisionId: string;
      try {
        const installation = await setup.query<{ id: string }>(`
          insert into installations (
            github_installation_id, account_login, account_type, status, permissions
          ) values (501, 'workspace-a', 'Organization', 'active', '{}')
          returning id
        `);
        const repository = await setup.query<{ id: string }>(`
          insert into repositories (
            installation_id, github_repository_id, owner, name, default_branch, config_state
          ) values ($1, 601, 'workspace-a', 'api', 'main', 'valid')
          returning id
        `, [installation.rows[0]?.id]);
        const decision = await setup.query<{ id: string }>(`
          insert into routing_decisions (
            repository_id, delivery_id, routing_key, action, risk_score, details
          ) values ($1, 'main-upgrade-delivery', 'main-upgrade-routing', 'request_human_review', 50, '{}')
          returning id
        `, [repository.rows[0]?.id]);
        decisionId = requiredId(decision.rows[0]?.id);
        const absence = await setup.query<{ id: string }>(`
          insert into reviewer_absences (reviewer_handle, start_at, end_at)
          values ('@user-8d3a10', '2026-10-01T08:00:00Z', '2026-10-01T12:00:00Z')
          returning id
        `);
        absenceId = requiredId(absence.rows[0]?.id);
        const replacement = await setup.query<{ id: string }>(`
          insert into reviewer_replacements (
            absence_id, absence_revision, decision_id, unavailable_reviewer,
            replacement_reviewer, outcome, reason, started_at, completed_at
          ) values (
            $1, 1, $2, '@user-8d3a10', '@user-72c9ef', 'replaced',
            'scheduled absence', '2026-10-01T08:00:00Z', '2026-10-01T08:00:01Z'
          )
          returning id
        `, [absenceId, decisionId]);
        replacementId = requiredId(replacement.rows[0]?.id);
      } finally {
        await setup.end();
      }

      await runMigrations(databaseUrl);

      const verification = new pg.Pool({ connectionString: databaseUrl });
      try {
        await expect(appliedMigrations(verification)).resolves.toEqual(FINAL_MIGRATIONS);
        await expect(verification.query(`
          select absences.id, absences.external_actor_id, absences.workspace_id,
                 absences.provider, absences.provider_connection_id,
                 workspaces.external_key, connections.external_connection_id
          from reviewer_absences absences
          join workspaces on workspaces.id = absences.workspace_id
          join provider_connections connections
            on connections.workspace_id = absences.workspace_id
           and connections.provider = absences.provider
           and connections.id = absences.provider_connection_id
          where absences.id = $1
        `, [absenceId])).resolves.toMatchObject({
          rows: [{
            id: absenceId,
            external_actor_id: "@user-8d3a10",
            provider: "github",
            external_key: "self-hosted",
            external_connection_id: "501",
          }],
        });
        await expect(verification.query(
          "select change_request_id from routing_decisions where id = $1",
          [decisionId],
        )).resolves.toMatchObject({ rows: [{ change_request_id: null }] });
        await expect(verification.query(`
          select replacements.id, replacements.workspace_id, replacements.provider,
                 replacements.provider_connection_id, replacements.absence_id,
                 replacements.decision_id, replacements.unavailable_actor_id,
                 replacements.replacement_actor_id, replacements.mutation_intent_id,
                 replacements.state, replacements.last_error, replacements.selection_context
          from reviewer_replacements replacements
          where replacements.id = $1
        `, [replacementId])).resolves.toMatchObject({
          rows: [{
            id: replacementId,
            selection_context: null,
            absence_id: absenceId,
            decision_id: decisionId,
            unavailable_actor_id: "@user-8d3a10",
            replacement_actor_id: "@user-72c9ef",
            mutation_intent_id: null,
            provider: "github",
            state: "completed",
            last_error: null,
          }],
        });
      } finally {
        await verification.end();
      }
    });
  }, 20_000);

  it("retries a migrated Phase terminal decision with its source-bound historical event time", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await applyMigrationHistory(databaseUrl, [
        ...PRE_WORKSPACE_MIGRATIONS,
        "0005_workspace_scope.sql",
        "0006_decision_outbox.sql",
      ]);
      const setup = new pg.Pool({ connectionString: databaseUrl });
      let workspaceId: string;
      let repositoryId: string;
      let decisionId: string;
      let currentEvent: DecisionEventV1;
      try {
        const workspace = await setup.query<{ id: string }>(
          "select id from workspaces where external_key = 'self-hosted'",
        );
        workspaceId = requiredId(workspace.rows[0]?.id);
        const connection = await setup.query<{ id: string }>(`
          insert into provider_connections (
            workspace_id, provider, external_connection_id, workspace_login,
            account_type, status, permissions
          ) values ($1, 'github', 'phase-connection', 'workspace-a', 'Organization', 'active', '{}')
          returning id
        `, [workspaceId]);
        const repository = await setup.query<{ id: string }>(`
          insert into repositories (
            workspace_id, provider, provider_connection_id, external_repository_id,
            owner, name, default_branch, config_state
          ) values ($1, 'github', $2, 'phase-repository', 'workspace-a', 'api', 'main', 'valid')
          returning id
        `, [workspaceId, connection.rows[0]?.id]);
        repositoryId = requiredId(repository.rows[0]?.id);
        const decision = await setup.query<{ id: string }>(`
          insert into routing_decisions (
            workspace_id, repository_id, delivery_id, routing_key, action, risk_score,
            selected_reviewers, details, effective_config_hash, inheritance_mode,
            pull_number, head_sha, action_status, action_applied_at, created_at
          ) values (
            $1, $2, 'phase-upgrade-delivery', 'phase-upgrade-routing',
            'request_human_review', 50, '["@user-c79a42"]', '{}', 'phase-hash', 'legacy',
            17, 'phase-head', 'succeeded', '2026-10-01T08:30:00Z', '2026-10-01T07:00:00Z'
          )
          returning id
        `, [workspaceId, repositoryId]);
        decisionId = requiredId(decision.rows[0]?.id);
        const legacyPayload = {
          schemaVersion: 1 as const,
          occurredAt: "2026-10-01T08:00:00.000Z",
          workspaceId,
          provider: "github" as const,
          decisionId,
          repositoryId: "phase-repository",
          changeRequestId: "phase-change-request",
          routingKey: "phase-upgrade-routing",
          mode: "shadow" as const,
          action: "request_human_review" as const,
          riskScore: 50,
          selectedActors: ["@user-c79a42"],
          effectiveConfigurationHash: "phase-hash",
        };
        currentEvent = {
          ...legacyPayload,
          eventType: "routing_decision",
          eventId: `decision:${decisionId}:v1`,
        };
        await setup.query(`
          insert into decision_outbox (
            workspace_id, decision_id, schema_version, payload, occurred_at,
            available_at, attempt_count, last_error
          ) values (
            $1, $2, 1, $3::jsonb, '2026-10-01T08:00:00Z',
            '2026-10-01T08:05:00Z', 2, 'sink unavailable'
          )
        `, [workspaceId, decisionId, JSON.stringify(legacyPayload)]);
      } finally {
        await setup.end();
      }

      await runMigrations(databaseUrl);
      const db = createDatabase(databaseUrl);
      let callbackOccurredAt: Date | undefined;
      try {
        await expect(persistDecisionWithEvent(db, workspaceId, {
          decision: {
            repositoryId,
            deliveryId: "phase-upgrade-delivery",
            routingKey: "phase-upgrade-routing",
            changeRequestId: "phase-change-request",
            pullNumber: 17,
            headSha: "phase-head",
            mode: "shadow",
            action: "request_human_review",
            actionStatus: "pending",
            riskScore: 50,
            selectedReviewers: ["@user-c79a42"],
            details: {},
            effectiveConfigHash: "phase-hash",
            inheritanceMode: "legacy",
          },
          event: ({ occurredAt }) => {
            callbackOccurredAt = occurredAt;
            return { ...currentEvent, occurredAt: occurredAt.toISOString() };
          },
        })).resolves.toEqual({
          decisionId,
          actionStatus: "succeeded",
          actionError: null,
          actionAppliedAt: new Date("2026-10-01T08:30:00.000Z"),
        });
      } finally {
        await db.destroy();
      }
      expect(callbackOccurredAt).toEqual(new Date("2026-10-01T08:00:00.000Z"));

      const verification = new pg.Pool({ connectionString: databaseUrl });
      try {
        await expect(appliedMigrations(verification)).resolves.toEqual(FINAL_MIGRATIONS);
        const outbox = await verification.query<{
          workspace_id: string;
          event_id: string;
          event_type: string;
          decision_id: string;
          reviewer_replacement_id: string | null;
          payload: DecisionEventV1;
          available_at: Date;
          published_at: Date | null;
          attempt_count: number;
          last_error: string | null;
        }>(`
          select workspace_id, event_id, event_type, decision_id, reviewer_replacement_id,
                 payload, available_at, published_at, attempt_count, last_error
          from decision_outbox
        `);
        expect(outbox.rows).toEqual([{
          workspace_id: workspaceId,
          event_id: currentEvent.eventId,
          event_type: "routing_decision",
          decision_id: decisionId,
          reviewer_replacement_id: null,
          payload: currentEvent,
          available_at: new Date("2026-10-01T08:05:00.000Z"),
          published_at: null,
          attempt_count: 2,
          last_error: "sink unavailable",
        }]);
        await expect(verification.query(
          "select change_request_id, action_status, action_applied_at, created_at from routing_decisions where id = $1",
          [decisionId],
        )).resolves.toMatchObject({ rows: [{
          change_request_id: "phase-change-request",
          action_status: "succeeded",
          action_applied_at: new Date("2026-10-01T08:30:00.000Z"),
          created_at: new Date("2026-10-01T07:00:00.000Z"),
        }] });
      } finally {
        await verification.end();
      }
    });
  }, 20_000);
});

async function applyMigrationHistory(databaseUrl: string, names: readonly string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(`
      create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    for (const name of names) {
      const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await client.query("begin");
      try {
        await client.query(migration);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function appliedMigrations(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ name: string }>("select name from schema_migrations order by name");
  return result.rows.map((row) => row.name);
}

function requiredId(value: string | undefined): string {
  if (value === undefined) throw new Error("expected seeded row id");
  return value;
}
