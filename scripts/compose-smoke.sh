#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
base_compose_file="$repository_root/docker-compose.yml"
validator="$repository_root/scripts/validate-compose-smoke.mjs"
temporary_parent="${TMPDIR:-/tmp}"
temporary_directory=""
validated_temporary_directory=""
environment_file=""
override_file=""
private_key_file=""
webhook_secret_file=""
admin_password_file=""
session_secret_file=""
compose_project=""

has_valid_compose_context() {
  [[ -n "${compose_project:-}" && "$compose_project" == triagepilot-smoke-* ]] &&
    [[ -n "${environment_file:-}" && -f "$environment_file" ]] &&
    [[ -n "${override_file:-}" && -f "$override_file" ]] &&
    [[ "$environment_file" == "$validated_temporary_directory/environment" ]] &&
    [[ "$override_file" == "$validated_temporary_directory/compose.override.yml" ]]
}

compose() (
  has_valid_compose_context || return 1
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
    WORKER_POLL_MS \
    WORKER_ID \
    TRIAGEPILOT_WEB_BIND \
    TRIAGEPILOT_WEB_PORT \
    SMOKE_PRIVATE_KEY_HOST_PATH \
    SMOKE_WEBHOOK_SECRET_HOST_PATH \
    SMOKE_ADMIN_PASSWORD_HOST_PATH \
    SMOKE_SESSION_SECRET_HOST_PATH
  while IFS= read -r compose_variable; do
    unset "$compose_variable"
  done < <(compgen -v COMPOSE_)

  docker compose \
    --project-name "$compose_project" \
    -f "$base_compose_file" \
    -f "$override_file" \
    --env-file "$environment_file" \
    "$@"
)

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if has_valid_compose_context; then
    compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  fi

  case "${validated_temporary_directory:-}" in
    "$temporary_parent"/triagepilot-compose-smoke.*)
      [[ -d "$validated_temporary_directory" ]] && rm -rf -- "$validated_temporary_directory"
      ;;
    "") ;;
    *) echo "Refusing to remove an unvalidated temporary directory" >&2 ;;
  esac

  exit "$exit_status"
}

case "$temporary_parent" in
  /*) ;;
  *)
    echo "Compose smoke requires an absolute temporary directory" >&2
    exit 1
    ;;
esac

temporary_parent="$(cd "$temporary_parent" && pwd -P)"
temporary_directory="$(mktemp -d "$temporary_parent/triagepilot-compose-smoke.XXXXXX")"
temporary_directory="$(cd "$temporary_directory" && pwd -P)"

case "$temporary_directory" in
  "$temporary_parent"/triagepilot-compose-smoke.*) ;;
  *)
    echo "Compose smoke temporary directory validation failed" >&2
    exit 1
    ;;
esac

validated_temporary_directory="$temporary_directory"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

environment_file="$validated_temporary_directory/environment"
override_file="$validated_temporary_directory/compose.override.yml"
private_key_file="$validated_temporary_directory/private-key.pem"
webhook_secret_file="$validated_temporary_directory/webhook-secret"
admin_password_file="$validated_temporary_directory/admin-password"
session_secret_file="$validated_temporary_directory/session-secret"

umask 077
compose_project="triagepilot-smoke-$(openssl rand -hex 8)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$private_key_file" 2>/dev/null
openssl rand -hex 32 > "$webhook_secret_file"
openssl rand -hex 24 > "$admin_password_file"
openssl rand -hex 32 > "$session_secret_file"

cat > "$environment_file" <<EOF
NODE_ENV=production
APP_BASE_URL=http://127.0.0.1:8787
DATABASE_URL=postgres://triagepilot:triagepilot@postgres:5432/triagepilot
ADMIN_USERNAME=smoke-admin
ADMIN_PASSWORD=
ADMIN_PASSWORD_FILE=/run/secrets/triagepilot/admin-password
SESSION_SECRET=
SESSION_SECRET_FILE=/run/secrets/triagepilot/session-secret
GITHUB_ORGANIZATION=smoke-organization
GITHUB_APP_ID=12345
GITHUB_PRIVATE_KEY=
GITHUB_PRIVATE_KEY_FILE=/run/secrets/triagepilot/private-key.pem
GITHUB_WEBHOOK_SECRET=
GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/triagepilot/webhook-secret
WORKER_POLL_MS=250
WORKER_ID=smoke-worker
TRIAGEPILOT_WEB_BIND=127.0.0.1
TRIAGEPILOT_WEB_PORT=0
SMOKE_PRIVATE_KEY_HOST_PATH=$private_key_file
SMOKE_WEBHOOK_SECRET_HOST_PATH=$webhook_secret_file
SMOKE_ADMIN_PASSWORD_HOST_PATH=$admin_password_file
SMOKE_SESSION_SECRET_HOST_PATH=$session_secret_file
EOF

cat > "$override_file" <<'EOF'
services:
  postgres:
    ports: !reset []
  web:
    volumes:
      - type: bind
        source: ${SMOKE_PRIVATE_KEY_HOST_PATH}
        target: /run/secrets/triagepilot/private-key.pem
        read_only: true
      - type: bind
        source: ${SMOKE_WEBHOOK_SECRET_HOST_PATH}
        target: /run/secrets/triagepilot/webhook-secret
        read_only: true
      - type: bind
        source: ${SMOKE_ADMIN_PASSWORD_HOST_PATH}
        target: /run/secrets/triagepilot/admin-password
        read_only: true
      - type: bind
        source: ${SMOKE_SESSION_SECRET_HOST_PATH}
        target: /run/secrets/triagepilot/session-secret
        read_only: true
  worker:
    volumes:
      - type: bind
        source: ${SMOKE_PRIVATE_KEY_HOST_PATH}
        target: /run/secrets/triagepilot/private-key.pem
        read_only: true
EOF

compose config --format json | node "$validator" --config-sources \
  "$private_key_file" \
  "$webhook_secret_file" \
  "$admin_password_file" \
  "$session_secret_file"
compose up -d postgres
compose run --rm web pnpm db:migrate
compose up -d web worker

published_address="$(compose port web 8787)"
health_url="$(node "$validator" --health-url "$published_address")"
curl --fail --silent --show-error --output /dev/null --retry 20 --retry-delay 2 --retry-all-errors "$health_url"

echo "Compose smoke health check passed"
