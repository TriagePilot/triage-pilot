# Job Troubleshooting

Workers process queued jobs from Postgres.

Check worker logs:

```bash
docker compose logs worker
```

Check failed jobs:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select id, kind, attempt_count, max_attempts, last_error, updated_at as failed_at from jobs where status = 'failed' order by updated_at desc limit 20;"
```

Check GitHub action failures:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select d.id, r.owner || '/' || r.name as repository, d.action, d.action_error, d.action_failed_at from routing_decisions d join repositories r on r.id = d.repository_id where d.action_status = 'failed' order by d.action_failed_at desc limit 20;"
```

Inspect the current worker heartbeat:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select worker_id, heartbeat_at, now() - heartbeat_at as heartbeat_age from worker_heartbeat;"
```

An absent or stale heartbeat means the dashboard reports the worker as unavailable. Check `docker compose ps worker` and the worker logs before retrying failed work; transient failures are retried automatically, while exhausted and permanent failures remain visible for 90 days. Logs for scoped work include the workspace, provider connection, job, and relevant decision or absence identifiers. `pull request head changed before enforce actions` is an intentional permanent failure: the delayed job made no GitHub writes because its signed event head was no longer current. A subsequent GitHub event for the new head creates separate work.

## Diagnose reviewer replacement

Reviewer-absence activation jobs use kind `activate_reviewer_absence`. Check their revision and durable recovery state before changing anything:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select id, status, attempt_count, max_attempts, run_at, last_error, payload->>'absenceId' as absence_id, payload->>'absenceRevision' as revision, payload ? 'reviewerReplacementFinalizerRecovery' as has_recovery from jobs where kind = 'activate_reviewer_absence' order by updated_at desc limit 20;"
```

Inspect non-complete replacement records:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select id, absence_id, absence_revision, decision_id, unavailable_actor_id, replacement_actor_id, outcome, state, last_error, completed_at from reviewer_replacements where state <> 'completed' order by completed_at desc limit 20;"
```

`finalizer_pending` means GitHub effects may already have happened; restarting the worker lets the durable job resume only the recorded persistence or policy finalizer. Do not manually repeat the reviewer removal/request based only on that state. `permanent_failure` is terminal and leaves the human-review requirement unchanged. `no_replacement_available` is a completed routing outcome, not permission to reduce the required approval count. Cancelled or stale absence revisions are expected successful no-ops.

When a GitHub App installation is removed, TriagePilot revokes its local provider connection immediately and worker maintenance defers physical cascading deletion until no queued or running job still references it. A pending row below is therefore normally housekeeping, not active provider authority:

```bash
docker compose exec postgres psql -U triagepilot triagepilot -c \
  "select provider, external_connection_id, revoked_at, cleanup_completed_at from provider_connection_revocations order by revoked_at desc limit 20;"
```

Cleanup retries at worker startup and during maintenance. If `cleanup_completed_at` remains empty, confirm the worker is healthy and inspect queued/running jobs for that connection. Never delete a revocation tombstone merely to reconnect an old external installation ID; the fail-closed identity contract requires a genuinely new provider connection ID or explicit, carefully reviewed operator intervention.

## Recover missing or stalled routing

In the administrator operations ledger, routing decisions are grouped by pull request. Expand a group to inspect its recent revisions, or use **Re-run routing** to fetch the pull request's current GitHub state and enqueue a new routing revision. If the pull request has no recorded decision, paste its GitHub URL into **Run missing pull request**. The administrator session and bound workspace are required; an expired session returns control to the login flow.

Recovery is available only for open pull requests in active configured repositories. Unknown, cross-workspace, and inactive targets share the same not-found response so target existence is not leaked. A closed pull request is rejected explicitly. Recovery reads the pull request's current base, head, and draft state, then creates a fresh operator run identity. It creates an ordinary routing job, not a synthetic webhook receipt, and does not reuse the earlier delivery or routing key.

The worker resolves repository configuration from the current trusted base when it processes the queued run. Shadow mode therefore remains write-free, and draft pull requests are still governed by `routing.include_draft_pull_requests`. A successful queue response refreshes the operations ledger automatically; use the job query above if the new revision does not appear after the worker has had time to process it.
