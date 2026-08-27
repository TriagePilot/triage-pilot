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

An absent or stale heartbeat means the dashboard reports the worker as unavailable. Check `docker compose ps worker` and the worker logs before retrying failed work; transient failures are retried automatically, while exhausted and permanent failures remain visible for 90 days. `pull request head changed before enforce actions` is an intentional permanent failure: the delayed job made no GitHub writes because its signed event head was no longer current. A subsequent GitHub event for the new head creates separate work.

## Recover missing or stalled routing

In the administrator operations ledger, routing decisions are grouped by pull request. Expand a group to inspect its recent revisions, or use **Re-run routing** to fetch the pull request's current GitHub state and enqueue a new routing revision. If the pull request has no recorded decision, paste its GitHub URL into **Run missing pull request**.

Recovery is available only for open pull requests in active configured repositories. It creates an operator job, not a synthetic webhook receipt, and follows the normal repository configuration contract. Shadow mode therefore remains write-free, and draft pull requests are still governed by `routing.include_draft_pull_requests`.
