# Upgrades

The commands below name Compose files explicitly, so Compose does not automatically load `docker-compose.override.yml`. Append every local deployment override after `docker-compose.release.yml` in each command—for example `-f docker-compose.yml -f docker-compose.release.yml -f docker-compose.override.yml`—to preserve secret mounts, bindings, networks, resource limits, and other site-specific settings during the upgrade. Later files take precedence.

```bash
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.release.yml pull web worker
docker compose -f docker-compose.yml -f docker-compose.release.yml stop web worker
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.release.yml run --rm web pnpm db:migrate
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d web worker
```

Read the release notes before upgrading. Set `TRIAGEPILOT_IMAGE` in `.env` when you need an exact version or version-and-digest reference; otherwise the release overlay uses the version paired with the checked-out repository. Pull the new image first, stop both application processes, apply every migration exactly once, and then restart `web` and the single `worker`. Back up PostgreSQL before the migration step.

Tagged releases publish a versioned OCI image to GitHub Container Registry and a release manifest that records the exact package tarballs, highest public migration, image digest, source commit, `FSL-1.1-Apache-2.0` license identifier, artifact publication timestamp, and artifact Apache 2.0 future-license timestamp. The release overlay applies one image reference to both application services:

```dotenv
TRIAGEPILOT_IMAGE=ghcr.io/triagepilot/triage-pilot:1.1.0@sha256:02465d76467f1471b572a9605564c3b67bdbdb23e96cd773c4ca0ab205f39e4d
```

For exact pinning, pair the version tag with the published digest from `release-manifest.json` and your release evidence checksums. Do not advance only one package or only the image: the supported upgrade unit is the synchronized public release.

For a build-from-source deployment, replace the pull step with `docker compose build --pull` and run the remaining commands without `docker-compose.release.yml`.

The FSL-to-Apache-2.0 conversion applies separately to each version on the second anniversary of the date that version was made available. Older public versions may already be available under Apache 2.0 while newer versions remain under FSL. Manifest timestamps describe artifact publication provenance and do not override an earlier source-availability date recorded by public Git history. Third-party dependencies retain their original licenses and required notices.

Run `bash scripts/test-previous-release-upgrade.sh` before approving a release. It starts the last public schema baseline, inserts representative installation, repository, webhook, job, and routing-decision data, migrates to the current public schema, and verifies both migrated data and the current web health endpoint.

The Phase 0 parity candidate migrates through `0010_provider_connection_preemptive_revocations.sql`. Its immutable history intentionally contains both `0005_reviewer_availability.sql` and `0005_workspace_scope.sql`: migrations are identified by complete filename, so the shared numeric prefix is not a collision. Do not rename, combine, or mark either file manually. Release-manifest generation and the previous-release upgrade harness both refuse a history that omits either lineage.

The availability migrations centralize existing absence records under the local workspace/provider connection and add revisioned activation jobs, replacement history, durable mutation intent, and finalizer state. The provider-revocation migrations make installation deletion status-first: authorization stops immediately, while worker maintenance removes the revoked connection and dependent rows later when no queued or running job still references it. A pending tombstone after upgrade is not an active connection and must not be deleted to force reconnection.

Database migrations are forward-only. Once a release applies a migration, rollback means redeploying the last application image that is still compatible with the new schema state; do not edit `schema_migrations` or attempt to reverse committed SQL in place. If you also operate a private extension, apply the public release first and only then run any private follow-on deployment so the shared database is always at least at the public migration level.
