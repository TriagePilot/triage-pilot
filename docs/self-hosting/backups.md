# Backups

Back up Postgres with `pg_dump`.

```bash
docker compose exec postgres pg_dump -U triagepilot triagepilot > triagepilot.sql
```

Restore with `psql` into a fresh database.

```bash
cat triagepilot.sql | docker compose exec -T postgres psql -U triagepilot triagepilot
```

The database backup contains installation and repository projections, webhook receipt identifiers, jobs, routing decisions with action outcomes, and the current worker heartbeat. Administrator and GitHub credentials are not stored in PostgreSQL; retain the deployment's environment and mounted secret files in your normal secret-management backup separately.
