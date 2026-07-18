#!/usr/bin/env bash
# EduAgent deploy (plans/08 §2): git pull → compose build → up -d → verify
# /healthz (db:ok + codex:ok) → tag images for one-command rollback.
#
#   On the VPS (repo at /opt/eduagent):   ./deploy/deploy.sh
#   From a workstation:                   DEPLOY_HOST=deploy@<vps> ./deploy/deploy.sh
#
# Requires .env.production next to docker-compose.yml (see the .example).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${DEPLOY_HOST:-}" ]]; then
  exec ssh "$DEPLOY_HOST" "cd ${DEPLOY_DIR:-/opt/eduagent} && ./deploy/deploy.sh"
fi

ENV_FILE="${ENV_FILE:-.env.production}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE not found — copy .env.production.example and fill it in" >&2
  exit 1
fi
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

echo '== git pull (main must stay deployable — plans/08 §2)'
git pull --ff-only

echo '== tagging current images :prev for rollback'
for img in eduagent-web eduagent-server; do
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:prev"
  fi
done

echo '== docker compose build'
compose build

echo '== docker compose up -d'
compose up -d

echo '== verifying /healthz (db:ok + codex:ok — fail loudly now, not in front of a judge)'
ENV_FILE="$ENV_FILE" ./deploy/healthcheck.sh 36

sha=$(git rev-parse --short HEAD)
for img in eduagent-web eduagent-server; do
  docker tag "$img:latest" "$img:$sha"
done
echo "== deployed $sha  (rollback: ./deploy/rollback.sh)"
