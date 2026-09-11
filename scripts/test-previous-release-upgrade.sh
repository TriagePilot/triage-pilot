#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_validator="$repository_root/scripts/validate-compose-smoke.mjs"
temporary_parent="${TMPDIR:-/tmp}"
temporary_directory=""
validated_temporary_directory=""
compose_project=""
compose_file=""
environment_file=""
private_key_file=""
webhook_secret_file=""
admin_password_file=""
session_secret_file=""
previous_checkout=""
current_version=""
current_image=""
previous_image=""
previous_release_commit="${TRIAGEPILOT_UPGRADE_PREVIOUS_RELEASE_COMMIT:-9d58fcffb04b381293c4730f947f7d7a4fad4782}"
current_image_provided="${TRIAGEPILOT_UPGRADE_CURRENT_IMAGE:-}"

compose() (
  [[ -n "${compose_project:-}" && "$compose_project" == triagepilot-upgrade-* ]] || return 1
  [[ -n "${compose_file:-}" && -f "$compose_file" ]] || return 1
  [[ -n "${environment_file:-}" && -f "$environment_file" ]] || return 1

  unset \
    NODE_ENV \
    APP_BASE_URL \
    DATABASE_URL \
    ADMIN_USERNAME \
    ADMIN_PASSWORD \
    ADMIN_PASSWORD_FILE \
    SESSION_SECRET \
    SESSION_SECRET_FILE \
    GITHUB_ORGANIZATION \
    GITHUB_APP_ID \
    GITHUB_PRIVATE_KEY \
    GITHUB_PRIVATE_KEY_FILE \
    GITHUB_WEBHOOK_SECRET \
    GITHUB_WEBHOOK_SECRET_FILE \
    TRIAGEPILOT_UPGRADE_CURRENT_IMAGE \
    TRIAGEPILOT_UPGRADE_PREVIOUS_IMAGE
  while IFS= read -r compose_variable; do
    unset "$compose_variable"
  done < <(compgen -v COMPOSE_)

  docker compose \
    --project-name "$compose_project" \
    -f "$compose_file" \
    --env-file "$environment_file" \
    "$@"
)

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if [[ -n "${compose_project:-}" ]]; then
    compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  fi

  case "${validated_temporary_directory:-}" in
    "$temporary_parent"/triagepilot-release-upgrade.*)
      [[ -d "$validated_temporary_directory" ]] && rm -rf -- "$validated_temporary_directory"
      ;;
    "") ;;
    *) echo "Refusing to remove an unvalidated temporary directory" >&2 ;;
  esac

  exit "$exit_status"
}

psql_exec() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U triagepilot -d triagepilot "$@"
}

wait_for_health() {
  local service_name=$1
  local published_address
  local health_url

  published_address="$(compose port "$service_name" 8787)"
  health_url="$(node "$compose_validator" --health-url "$published_address")"
  curl --fail --silent --show-error --output /dev/null --retry 30 --retry-delay 2 --retry-all-errors "$health_url"
}

query_single_value() {
  local sql=$1
  psql_exec -tA -c "$sql" | tr -d '[:space:]'
}

query_single_line() {
  local sql=$1
  psql_exec -tA -F '|' -c "$sql" | sed '/^[[:space:]]*$/d' | head -n 1
}

case "$temporary_parent" in
  /*) ;;
  *)
    echo "Release upgrade verification requires an absolute temporary directory" >&2
    exit 1
    ;;
esac

temporary_parent="$(cd "$temporary_parent" && pwd -P)"
temporary_directory="$(mktemp -d "$temporary_parent/triagepilot-release-upgrade.XXXXXX")"
temporary_directory="$(cd "$temporary_directory" && pwd -P)"

case "$temporary_directory" in
  "$temporary_parent"/triagepilot-release-upgrade.*) ;;
  *)
    echo "Release upgrade temporary directory validation failed" >&2
    exit 1
    ;;
esac

validated_temporary_directory="$temporary_directory"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose_project="triagepilot-upgrade-$(openssl rand -hex 8)"
compose_file="$validated_temporary_directory/compose.yml"
environment_file="$validated_temporary_directory/environment"
private_key_file="$validated_temporary_directory/private-key.pem"
webhook_secret_file="$validated_temporary_directory/webhook-secret"
admin_password_file="$validated_temporary_directory/admin-password"
session_secret_file="$validated_temporary_directory/session-secret"
previous_checkout="$validated_temporary_directory/previous-release"

current_version="$(cd "$repository_root" && node --input-type=module -e "import { readFileSync } from 'node:fs'; const manifest = JSON.parse(readFileSync('package.json', 'utf8')); process.stdout.write(manifest.version);")"

previous_image="triagepilot-previous-release:${previous_release_commit:0:12}"
current_image="${current_image_provided:-triagepilot-current-release:${current_version}}"

umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$private_key_file" 2>/dev/null
openssl rand -hex 32 > "$webhook_secret_file"
openssl rand -hex 24 > "$admin_password_file"
openssl rand -hex 32 > "$session_secret_file"

mkdir -p "$previous_checkout"
if ! git -C "$repository_root" cat-file -e "${previous_release_commit}^{commit}" 2>/dev/null; then
  echo "Previous release commit ${previous_release_commit} is unavailable in this checkout. Fetch full history first." >&2
  exit 1
fi
git -C "$repository_root" archive "$previous_release_commit" | tar -xf - -C "$previous_checkout"

if [[ -z "$current_image_provided" ]]; then
  docker build \
    --build-arg "TRIAGEPILOT_VERSION=$current_version" \
    --tag "$current_image" \
    "$repository_root"
fi
docker build --tag "$previous_image" "$previous_checkout"

cat > "$environment_file" <<EOF
NODE_ENV=production
APP_BASE_URL=http://127.0.0.1:8787
DATABASE_URL=postgres://triagepilot:triagepilot@postgres:5432/triagepilot
ADMIN_USERNAME=upgrade-admin
ADMIN_PASSWORD=
ADMIN_PASSWORD_FILE=/run/secrets/triagepilot/admin-password
SESSION_SECRET=
SESSION_SECRET_FILE=/run/secrets/triagepilot/session-secret
GITHUB_ORGANIZATION=upgrade-organization
GITHUB_APP_ID=12345
GITHUB_PRIVATE_KEY=
GITHUB_PRIVATE_KEY_FILE=/run/secrets/triagepilot/private-key.pem
GITHUB_WEBHOOK_SECRET=
GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/triagepilot/webhook-secret
TRIAGEPILOT_UPGRADE_PREVIOUS_IMAGE=$previous_image
TRIAGEPILOT_UPGRADE_CURRENT_IMAGE=$current_image
EOF

cat > "$compose_file" <<EOF
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: triagepilot
      POSTGRES_PASSWORD: triagepilot
      POSTGRES_DB: triagepilot
    ports:
      - "127.0.0.1::5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U triagepilot -d triagepilot"]
      interval: 10s
      timeout: 5s
      retries: 10

  web-previous:
    image: \${TRIAGEPILOT_UPGRADE_PREVIOUS_IMAGE}
    command: pnpm --filter @triagepilot/web start
    restart: unless-stopped
    environment:
      NODE_ENV: \${NODE_ENV}
      APP_BASE_URL: \${APP_BASE_URL}
      DATABASE_URL: \${DATABASE_URL}
      ADMIN_USERNAME: \${ADMIN_USERNAME}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      ADMIN_PASSWORD_FILE: \${ADMIN_PASSWORD_FILE}
      SESSION_SECRET: \${SESSION_SECRET}
      SESSION_SECRET_FILE: \${SESSION_SECRET_FILE}
      GITHUB_ORGANIZATION: \${GITHUB_ORGANIZATION}
      GITHUB_APP_ID: \${GITHUB_APP_ID}
      GITHUB_PRIVATE_KEY: \${GITHUB_PRIVATE_KEY}
      GITHUB_PRIVATE_KEY_FILE: \${GITHUB_PRIVATE_KEY_FILE}
      GITHUB_WEBHOOK_SECRET: \${GITHUB_WEBHOOK_SECRET}
      GITHUB_WEBHOOK_SECRET_FILE: \${GITHUB_WEBHOOK_SECRET_FILE}
    ports:
      - "127.0.0.1::8787"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - type: bind
        source: $private_key_file
        target: /run/secrets/triagepilot/private-key.pem
        read_only: true
      - type: bind
        source: $webhook_secret_file
        target: /run/secrets/triagepilot/webhook-secret
        read_only: true
      - type: bind
        source: $admin_password_file
        target: /run/secrets/triagepilot/admin-password
        read_only: true
      - type: bind
        source: $session_secret_file
        target: /run/secrets/triagepilot/session-secret
        read_only: true

  web-current:
    image: \${TRIAGEPILOT_UPGRADE_CURRENT_IMAGE}
    command: pnpm --filter @triagepilot/web start
    restart: unless-stopped
    environment:
      NODE_ENV: \${NODE_ENV}
      APP_BASE_URL: \${APP_BASE_URL}
      DATABASE_URL: \${DATABASE_URL}
      ADMIN_USERNAME: \${ADMIN_USERNAME}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      ADMIN_PASSWORD_FILE: \${ADMIN_PASSWORD_FILE}
      SESSION_SECRET: \${SESSION_SECRET}
      SESSION_SECRET_FILE: \${SESSION_SECRET_FILE}
      GITHUB_ORGANIZATION: \${GITHUB_ORGANIZATION}
      GITHUB_APP_ID: \${GITHUB_APP_ID}
      GITHUB_PRIVATE_KEY: \${GITHUB_PRIVATE_KEY}
      GITHUB_PRIVATE_KEY_FILE: \${GITHUB_PRIVATE_KEY_FILE}
      GITHUB_WEBHOOK_SECRET: \${GITHUB_WEBHOOK_SECRET}
      GITHUB_WEBHOOK_SECRET_FILE: \${GITHUB_WEBHOOK_SECRET_FILE}
    ports:
      - "127.0.0.1::8787"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - type: bind
        source: $private_key_file
        target: /run/secrets/triagepilot/private-key.pem
        read_only: true
      - type: bind
        source: $webhook_secret_file
        target: /run/secrets/triagepilot/webhook-secret
        read_only: true
      - type: bind
        source: $admin_password_file
        target: /run/secrets/triagepilot/admin-password
        read_only: true
      - type: bind
        source: $session_secret_file
        target: /run/secrets/triagepilot/session-secret
        read_only: true

  migrate-current:
    image: \${TRIAGEPILOT_UPGRADE_CURRENT_IMAGE}
    command: pnpm db:migrate
    restart: "no"
    environment:
      DATABASE_URL: \${DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres-data:
EOF

compose up -d --wait --wait-timeout 120 postgres

psql_exec <<'SQL'
create table schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
SQL

for migration in \
  0001_initial.sql \
  0002_selected_reviewers.sql \
  0003_human_review_policy.sql \
  0004_semantic_routing_deduplication.sql
do
  psql_exec < "$previous_checkout/packages/db/migrations/$migration"
  psql_exec -c "insert into schema_migrations (name) values ('$migration')"
done

compose up -d web-previous
wait_for_health web-previous

psql_exec <<'SQL'
insert into installations (
  github_installation_id, account_login, account_type, status, permissions
) values (99, 'acme', 'Organization', 'active', '{}'::jsonb);

insert into repositories (
  installation_id, github_repository_id, owner, name, default_branch, config_state
) values (
  (select id from installations where github_installation_id = 99),
  200,
  'acme',
  'api',
  'main',
  'valid'
);

insert into webhook_receipts (delivery_id, event_name, installation_id, event_action, hook_id)
values ('delivery-1', 'pull_request', 99, 'opened', 'hook-1');

insert into jobs (kind, payload, idempotency_key)
values (
  'process_pull_request',
  '{"providerConnectionId":"99","changeRequest":{"repository":{"provider":"github"}}}'::jsonb,
  'job-1'
);

insert into routing_decisions (
  repository_id, delivery_id, routing_key, action, risk_score, details
) values (
  (select id from repositories where github_repository_id = 200),
  'delivery-1',
  'routing-1',
  'policy_approval',
  5,
  '{"legacy":true}'::jsonb
);
SQL

compose stop web-previous
compose run --rm migrate-current
compose up -d web-current
wait_for_health web-current

latest_migration="$(query_single_value "select name from schema_migrations order by name desc limit 1")"
[[ "$latest_migration" == "0010_provider_connection_preemptive_revocations.sql" ]] || {
  echo "Expected highest migration 0010_provider_connection_preemptive_revocations.sql, found $latest_migration" >&2
  exit 1
}

historical_0005_migrations="$(query_single_value "select string_agg(name, ',' order by name) from schema_migrations where name like '0005_%'")"
[[ "$historical_0005_migrations" == "0005_reviewer_availability.sql,0005_workspace_scope.sql" ]] || {
  echo "Expected both historical 0005 migrations, found $historical_0005_migrations" >&2
  exit 1
}

workspace_row="$(query_single_line "select external_key, id from workspaces")"
workspace_external_key="${workspace_row%%|*}"
workspace_id="${workspace_row##*|}"
[[ "$workspace_external_key" == "self-hosted" ]] || {
  echo "Expected self-hosted workspace, found $workspace_external_key" >&2
  exit 1
}
[[ "$workspace_id" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "Expected UUID workspace id, found $workspace_id" >&2
  exit 1
}

provider_row="$(query_single_line "select workspace_id, provider, external_connection_id, workspace_login from provider_connections")"
[[ "$provider_row" == "${workspace_id}|github|99|acme" ]] || {
  echo "Unexpected provider connection row: $provider_row" >&2
  exit 1
}

repository_row="$(query_single_line "select workspace_id, provider, external_repository_id from repositories")"
[[ "$repository_row" == "${workspace_id}|github|200" ]] || {
  echo "Unexpected repository row: $repository_row" >&2
  exit 1
}

receipt_row="$(query_single_line "select workspace_id, provider, external_connection_id from webhook_receipts")"
[[ "$receipt_row" == "${workspace_id}|github|99" ]] || {
  echo "Unexpected webhook receipt row: $receipt_row" >&2
  exit 1
}

job_row="$(query_single_line "select workspace_id, provider from jobs")"
[[ "$job_row" == "${workspace_id}|github" ]] || {
  echo "Unexpected job row: $job_row" >&2
  exit 1
}

routing_row="$(query_single_line "select workspace_id, inheritance_mode, length(effective_config_hash), config_diagnostics::text, config_sources::text from routing_decisions")"
[[ "$routing_row" == "${workspace_id}|legacy|64|[]|{}" ]] || {
  echo "Unexpected routing decision row: $routing_row" >&2
  exit 1
}

outbox_table_count="$(query_single_value "select count(*) from information_schema.tables where table_name = 'decision_outbox'")"
[[ "$outbox_table_count" == "1" ]] || {
  echo "Expected decision_outbox table to exist after upgrade" >&2
  exit 1
}

echo "Previous-release upgrade verification passed"
