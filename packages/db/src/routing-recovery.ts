import { sql, type Kysely } from "kysely";

import type { Database } from "./kysely";

export interface RoutingRecoveryTarget {
  githubInstallationId: string;
  githubRepositoryId: string;
  owner: string;
  repo: string;
  pullNumber: number;
}

export type FindRoutingRecoveryTargetInput = {
  githubOrganization: string;
} & (
  | { decisionId: string }
  | { owner: string; repo: string; pullNumber: number }
);

export async function findRoutingRecoveryTarget(
  db: Kysely<Database>,
  input: FindRoutingRecoveryTargetInput,
): Promise<RoutingRecoveryTarget | null> {
  let query = db
    .selectFrom("repositories")
    .innerJoin("installations", "installations.id", "repositories.installation_id")
    .select([
      "installations.github_installation_id as githubInstallationId",
      "repositories.github_repository_id as githubRepositoryId",
      "repositories.owner",
      "repositories.name as repo",
    ])
    .where("installations.status", "=", "active")
    .where(sql<boolean>`lower(installations.account_login) = lower(${input.githubOrganization})`);

  if ("decisionId" in input) {
    const row = await query
      .innerJoin("routing_decisions", "routing_decisions.repository_id", "repositories.id")
      .select(sql<number | null>`coalesce(
        routing_decisions.pull_number,
        case
          when jsonb_typeof(routing_decisions.details -> 'pullNumber') = 'number'
            and routing_decisions.details ->> 'pullNumber' ~ '^[1-9][0-9]{0,9}$'
            and (routing_decisions.details ->> 'pullNumber')::numeric <= 2147483647
          then (routing_decisions.details ->> 'pullNumber')::integer
          else null
        end
      )`.as("pullNumber"))
      .where(sql<boolean>`routing_decisions.id::text = ${input.decisionId}`)
      .executeTakeFirst();
    return row?.pullNumber === null || row === undefined ? null : { ...row, pullNumber: row.pullNumber };
  }

  const row = await query
    .where(sql<boolean>`lower(repositories.owner) = lower(${input.owner})`)
    .where(sql<boolean>`lower(repositories.name) = lower(${input.repo})`)
    .executeTakeFirst();
  return row ? { ...row, pullNumber: input.pullNumber } : null;
}
