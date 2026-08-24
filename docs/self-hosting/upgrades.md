# Upgrades

```bash
git pull --ff-only
docker compose build --pull
docker compose stop web worker
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
docker compose up -d web worker
```

Read the release notes before upgrading. Build the new image first, stop both application processes, apply every migration exactly once, and then restart `web` and the single `worker`. Back up PostgreSQL before the migration step.

Tagged releases publish multi-architecture images to GitHub Container Registry. Build-from-source Compose remains the reference deployment.
