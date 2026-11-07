import { sql, type Kysely } from "kysely";
import type { AnalyticsFacts, AnalyticsRepositoryScope, ExternalActorId } from "@triagepilot/contracts";
import type { Database } from "./kysely.js";
import { assertAnalyticsScopeActive } from "./reviewer-backlog.js";
import { actors, normalizeAnalyticsDecision, object, readOriginalReviewerActors, type AnalyticsDecisionRow } from "./analytics-records.js";

type SourceRow = Omit<AnalyticsDecisionRow, "changeRequest"> & { latest: boolean };
/** Historical facts share one repeatable-read, read-only source snapshot. */
export async function readAnalyticsFacts(db: Kysely<Database>, scope: AnalyticsRepositoryScope, input: { start: Date; end: Date }): Promise<AnalyticsFacts> {
  if (!Number.isFinite(input.start.getTime()) || !Number.isFinite(input.end.getTime()) || input.start > input.end) throw new RangeError("Invalid analytics interval");
  await assertAnalyticsScopeActive(db, scope);
  const result = await db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute(async trx => {
    const facts: AnalyticsFacts = { latestDecisions: [], assignments: [], knownActors: [], coverage: { unidentifiedDecisions: 0, unknownOriginalAssignments: 0 } };
    if (scope.repositories.length === 0) return facts;
    const horizon = new Date(input.end.getTime() - 90 * 86_400_000);
    const start = new Date(Math.max(horizon.getTime(), input.start.getTime()));
    // Deliberately do not filter by mode/action/success before ranking outcomes.
    const source = sql`select d.* from routing_decisions d
      join repositories r on r.id = d.repository_id and r.workspace_id = d.workspace_id
      join provider_connections c on c.id = r.provider_connection_id and c.workspace_id = r.workspace_id and c.provider = r.provider
      where d.workspace_id = ${scope.workspaceId} and r.provider = 'github'
        and r.provider_connection_id = ${scope.providerConnectionId} and c.status = 'active'
        and r.id in (${sql.join(scope.repositories.map(r => r.recordId))})
        and d.created_at >= ${horizon} and d.created_at < ${input.end}`;
    const { rows } = await sql<SourceRow>`with scoped as (${source}), latest as (
      select distinct on (repository_id, change_request_id, pull_number) id from scoped
      where created_at >= ${start} and created_at < ${input.end}
      order by repository_id, change_request_id, pull_number, created_at desc, id desc
    ) select s.id, s.repository_id, s.change_request_id, s.pull_number, s.created_at,
      s.action_applied_at, s.mode, s.action, s.action_status, s.risk_score, s.details,
      exists(select 1 from latest l where l.id = s.id) as latest
      from scoped s order by s.created_at, s.id`.execute(trx);
    const known = new Set<ExternalActorId>();
    const byId = new Map<string, AnalyticsDecisionRow>();
    const inPeriod = (at: Date) => at >= start && at < input.end;
    for (const row of rows) {
      const repository = scope.repositories.find(repository => repository.recordId === row.repository_id)!;
      const normalizedRow: AnalyticsDecisionRow = { ...row, changeRequest: { repositoryRecordId: repository.recordId, repository: { ...repository.repository }, providerConnectionId: scope.providerConnectionId, changeRequestId: row.change_request_id ?? "", changeRequestNumber: row.pull_number ?? 0 } };
      const fact = normalizeAnalyticsDecision(normalizedRow);
      if (fact === null) {
        if (inPeriod(row.created_at)) facts.coverage.unidentifiedDecisions++;
        continue;
      }
      byId.set(row.id, normalizedRow);
      if (row.latest) facts.latestDecisions.push(fact);
      for (const actor of actors(object(object(row.details).ownership).eligibleReviewers) ?? []) known.add(actor);
    }
    // Event timestamps are independent of outcome selection and decision creation.
    const events = await sql<{ decision_id: string; actor: string | null; occurred_at: Date; source: "routing" | "replacement" }>`with scoped as (${source})
      select d.id as decision_id, null::text as actor,
        case when d.mode = 'shadow' then d.created_at else d.action_applied_at end as occurred_at,
        'routing'::text as source
      from scoped d where d.action = 'request_human_review'
        and (d.mode = 'shadow' or d.action_status = 'succeeded')
        and (case when d.mode = 'shadow' then d.created_at else d.action_applied_at end) >= ${start}
        and (case when d.mode = 'shadow' then d.created_at else d.action_applied_at end) < ${input.end}
      union all
      select x.decision_id, x.replacement_actor_id, x.completed_at, 'replacement'::text
      from reviewer_replacements x join scoped d on d.id = x.decision_id and d.workspace_id = x.workspace_id
      where x.workspace_id = ${scope.workspaceId} and x.provider = 'github' and x.provider_connection_id = ${scope.providerConnectionId}
        and x.completed_at >= ${start} and x.completed_at < ${input.end}
        and ((x.outcome = 'replaced' and d.mode = 'enforce') or (x.outcome = 'simulated_replacement' and d.mode = 'shadow'))
      order by occurred_at, decision_id, source, actor`.execute(trx);
    for (const event of events.rows) {
      const row = byId.get(event.decision_id);
      if (!row) continue;
      const recipients = event.source === "routing" ? readOriginalReviewerActors(row.details) : actors([event.actor]);
      if (recipients === null) {
        if (event.source === "routing") facts.coverage.unknownOriginalAssignments++;
        continue;
      }
      for (const actor of recipients) {
        facts.assignments.push({ changeRequest: row.changeRequest, actor, occurredAt: event.occurred_at.toISOString(), mode: row.mode, source: event.source });
        known.add(actor);
      }
    }
    facts.knownActors = [...known].sort();
    return facts;
  });
  await assertAnalyticsScopeActive(db, scope);
  return result;
}
