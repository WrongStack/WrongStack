#!/bin/sh
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE=${WRONGSTACK_HQ_COMPOSE_FILE:-$DEPLOY_DIR/compose.yaml}
SERVICE=hq

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" "$@"
}

wait_healthy() {
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    container_id=$(compose ps -q "$SERVICE")
    if [ -n "$container_id" ]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)
      if [ "$health" = "healthy" ]; then
        return 0
      fi
      if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
        return 1
      fi
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

image_ref=$(compose config --images | head -n 1)
if [ -z "$image_ref" ] || [ "$image_ref" = "wrongstack-hq:local" ]; then
  echo "Set WRONGSTACK_HQ_IMAGE to a remote immutable repository tag before automatic updates." >&2
  exit 1
fi

old_container=$(compose ps -q "$SERVICE")
old_image=""
if [ -n "$old_container" ]; then
  old_image=$(docker inspect --format '{{.Image}}' "$old_container")
fi

# Pull failure leaves the currently running container untouched.
compose pull "$SERVICE"
if compose up -d --no-deps --force-recreate "$SERVICE" && wait_healthy; then
  echo "WrongStack HQ container updated and healthy: $image_ref"
  exit 0
fi

if [ -z "$old_image" ]; then
  echo "New HQ container failed health checks and no previous image exists for rollback." >&2
  exit 1
fi

echo "New HQ container failed health checks; rolling back to $old_image." >&2
docker image tag "$old_image" "$image_ref"
compose up -d --no-deps --force-recreate "$SERVICE"
if wait_healthy; then
  echo "Rollback succeeded; the prior HQ image is healthy." >&2
else
  echo "Rollback failed; inspect docker compose logs hq immediately." >&2
fi
exit 1
