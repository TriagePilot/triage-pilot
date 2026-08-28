# Upgrades

```bash
git pull --ff-only
docker compose build --pull
docker compose stop web worker
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
docker compose up -d web worker
```

Read the release notes before upgrading. Build or pull the new image first, stop both application processes, apply every migration exactly once, and then restart `web` and the single `worker`. Back up PostgreSQL before the migration step.

Tagged releases publish a versioned OCI image to GitHub Container Registry and a release manifest that records the exact package tarballs, highest public migration, image digest, source commit, `FSL-1.1-Apache-2.0` license identifier, artifact publication timestamp, and artifact Apache 2.0 future-license timestamp. Build-from-source Compose remains the reference deployment, but the release image can be pinned exactly with a small override:

```yaml
services:
  web:
    image: ghcr.io/triagepilot/triage-pilot:0.1.0
    build: !reset null
  worker:
    image: ghcr.io/triagepilot/triage-pilot:0.1.0
    build: !reset null
```

For exact pinning, pair the version tag with the published digest from `release-manifest.json` and your release evidence checksums. Do not advance only one package or only the image: the supported upgrade unit is the synchronized public release.

The FSL-to-Apache-2.0 conversion applies separately to each version on the second anniversary of the date that version was made available. Older public versions may already be available under Apache 2.0 while newer versions remain under FSL. Manifest timestamps describe artifact publication provenance and do not override an earlier source-availability date recorded by public Git history. Third-party dependencies retain their original licenses and required notices.

Run `bash scripts/test-previous-release-upgrade.sh` before approving a release. It starts the last public schema baseline, inserts representative installation, repository, webhook, job, and routing-decision data, migrates to the current public schema, and verifies both migrated data and the current web health endpoint.

Database migrations are forward-only. Once a release applies a migration, rollback means redeploying the last application image that is still compatible with the new schema state; do not edit `schema_migrations` or attempt to reverse committed SQL in place. If you also operate a private extension, apply the public release first and only then run any private follow-on deployment so the shared database is always at least at the public migration level.
