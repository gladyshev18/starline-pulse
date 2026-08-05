#!/usr/bin/env bash
set -Eeuo pipefail
set -f

APP_DIR=/opt/chery-pulse
EXPECTED_WEB_REPOSITORY=ghcr.io/gladyshev18/chery-pulse-web
EXPECTED_TASKS_REPOSITORY=ghcr.io/gladyshev18/chery-pulse-tasks

set -- ${SSH_ORIGINAL_COMMAND:-}
if [[ $# -ne 4 || "$1" != deploy ]]; then
  echo "Only the chery-pulse deploy command is allowed" >&2
  exit 126
fi

web_image="$2"
tasks_image="$3"
ghcr_user="$4"

if [[ ! "$web_image" =~ ^${EXPECTED_WEB_REPOSITORY}:[0-9a-f]{40}$ ]]; then
  echo "Invalid web image" >&2
  exit 2
fi
if [[ ! "$tasks_image" =~ ^${EXPECTED_TASKS_REPOSITORY}:[0-9a-f]{40}$ ]]; then
  echo "Invalid tasks image" >&2
  exit 2
fi
if [[ ! "$ghcr_user" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Invalid GHCR user" >&2
  exit 2
fi

IFS= read -r ghcr_token
if [[ ${#ghcr_token} -lt 20 ]]; then
  echo "Missing GHCR token" >&2
  exit 2
fi

printf '%s' "$ghcr_token" | docker login ghcr.io --username "$ghcr_user" --password-stdin >/dev/null
unset ghcr_token

release_dir="$(mktemp -d)"
container_id=""
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$release_dir"
  docker logout ghcr.io >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker pull "$tasks_image"
container_id="$(docker create "$tasks_image")"
docker cp "$container_id:/app/release/." "$release_dir"
docker rm "$container_id" >/dev/null
container_id=""

install -d -m 700 "$APP_DIR/deploy"
install -m 600 "$release_dir/compose.yaml" "$APP_DIR/compose.yaml"
install -m 600 "$release_dir/deploy/Caddyfile" "$APP_DIR/deploy/Caddyfile"
install -m 700 "$release_dir/deploy/production-deploy.sh" "$APP_DIR/deploy/production-deploy.sh"
printf 'WEB_IMAGE=%s\nTASKS_IMAGE=%s\n' "$web_image" "$tasks_image" > "$APP_DIR/.env.deploy.next"
chmod 600 "$APP_DIR/.env.deploy.next"

"$APP_DIR/deploy/production-deploy.sh"
