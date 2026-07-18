#!/usr/bin/env bash
# Rolls containers back to the :prev images tagged by the last deploy.sh run.
# (Or: ENV IMAGE_TAG=<sha> to jump to any SHA-tagged build.)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
TAG="${IMAGE_TAG:-prev}"
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

for img in eduagent-web eduagent-server; do
  if ! docker image inspect "$img:$TAG" >/dev/null 2>&1; then
    echo "FATAL: $img:$TAG does not exist — nothing to roll back to" >&2
    exit 1
  fi
done
for img in eduagent-web eduagent-server; do
  docker tag "$img:$TAG" "$img:latest"
done

compose up -d --no-build --force-recreate web server
ENV_FILE="$ENV_FILE" ./deploy/healthcheck.sh 36

echo "rolled back to :$TAG. NOTE: the git checkout still points at the newer"
echo "commit — running containers are the older images until the next deploy."
