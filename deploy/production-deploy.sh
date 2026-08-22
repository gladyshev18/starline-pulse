#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/opt/starline-pulse
CURRENT_ENV="$APP_DIR/.env.deploy"
NEXT_ENV="$APP_DIR/.env.deploy.next"
PREVIOUS_ENV="$APP_DIR/.env.deploy.previous"
BACKUP_DIR="$APP_DIR/backups"
PROJECT_VOLUME=starline-pulse_app-data

cd "$APP_DIR"

if [[ ! -f .env.production ]]; then
  echo "Missing $APP_DIR/.env.production" >&2
  exit 1
fi

if [[ ! -s "$NEXT_ENV" ]]; then
  echo "Missing $NEXT_ENV" >&2
  exit 1
fi

chmod 600 .env.production "$NEXT_ENV"
install -d -m 700 "$BACKUP_DIR"
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

current_compose() {
  if [[ -s "$CURRENT_ENV" ]]; then
    docker compose --env-file "$CURRENT_ENV" "$@"
  else
    docker compose "$@"
  fi
}

previous_compose() {
  if [[ -s "$PREVIOUS_ENV" ]]; then
    docker compose --env-file "$PREVIOUS_ENV" "$@"
  else
    docker compose "$@"
  fi
}

next_compose() {
  docker compose --env-file "$NEXT_ENV" "$@"
}

rollback() {
  echo "Deployment failed; starting the previous application images" >&2
  if [[ -s "$PREVIOUS_ENV" ]]; then
    cp "$PREVIOUS_ENV" "$CURRENT_ENV"
    chmod 600 "$CURRENT_ENV"
  else
    rm -f "$CURRENT_ENV"
  fi
  previous_compose up -d --no-build --no-deps web worker caddy || true
}

echo "Pulling immutable images"
next_compose pull web worker migrate

if docker volume inspect "$PROJECT_VOLUME" >/dev/null 2>&1; then
  echo "Creating a consistent SQLite backup"
  current_compose stop web worker || true
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_tmp="$BACKUP_DIR/app-data-$timestamp.tar.gz.tmp"
  backup="$BACKUP_DIR/app-data-$timestamp.tar.gz"
  if current_compose run --rm --no-deps -T migrate sh -c 'tar -C /app/data -czf - .' > "$backup_tmp"; then
    mv "$backup_tmp" "$backup"
    chmod 600 "$backup"
  else
    rm -f "$backup_tmp"
    current_compose start web worker || true
    exit 1
  fi
fi

if [[ -s "$CURRENT_ENV" ]]; then
  cp "$CURRENT_ENV" "$PREVIOUS_ENV"
  chmod 600 "$PREVIOUS_ENV"
else
  rm -f "$PREVIOUS_ENV"
fi

echo "Applying database migrations"
if ! next_compose run --rm --no-deps migrate; then
  current_compose start web worker || true
  exit 1
fi

mv "$NEXT_ENV" "$CURRENT_ENV"
chmod 600 "$CURRENT_ENV"

echo "Starting the new release"
if ! docker compose --env-file "$CURRENT_ENV" up -d --no-build --no-deps --remove-orphans --wait --wait-timeout 120 web worker; then
  rollback
  exit 1
fi

if ! docker compose --env-file "$CURRENT_ENV" up -d --no-build --no-deps caddy; then
  rollback
  exit 1
fi

domain="$(sed -n 's/^APP_DOMAIN=//p' .env.production | tail -n 1)"
if [[ -z "$domain" ]]; then
  rollback
  echo "APP_DOMAIN is not configured" >&2
  exit 1
fi

echo "Checking the public health endpoint"
if ! curl --fail --silent --show-error --retry 10 --retry-delay 3 --retry-all-errors "https://$domain/api/health"; then
  rollback
  exit 1
fi
echo

find "$BACKUP_DIR" -type f -name 'app-data-*.tar.gz' -mtime +14 -delete

keep_file="$(mktemp)"
trap 'rm -f "$keep_file"; docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
for env_file in "$CURRENT_ENV" "$PREVIOUS_ENV"; do
  if [[ -s "$env_file" ]]; then
    sed -n -E 's/^(WEB_IMAGE|TASKS_IMAGE)=//p' "$env_file"
  fi
done | sort -u > "$keep_file"
docker image ls --format '{{.Repository}}:{{.Tag}}' | while IFS= read -r image; do
  case "$image" in
    ghcr.io/gladyshev18/starline-pulse-web:*|ghcr.io/gladyshev18/starline-pulse-tasks:*)
      if ! grep -Fqx "$image" "$keep_file"; then
        docker image rm "$image" >/dev/null 2>&1 || true
      fi
      ;;
  esac
done
docker image prune -f >/dev/null

docker compose --env-file "$CURRENT_ENV" ps
