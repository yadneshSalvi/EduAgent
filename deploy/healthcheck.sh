#!/usr/bin/env bash
# Polls /healthz INSIDE the server container until it reports ok:true AND
# codex:ok, or times out. Used by deploy.sh / rollback.sh / cron/reset-alex.sh.
# Usage: [ENV_FILE=.env.production] [COMPOSE_FILES="-f a.yml -f b.yml"] \
#          ./deploy/healthcheck.sh [tries]   # tries × 5s, default 36 (3 min)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
tries="${1:-36}"

probe() {
  # shellcheck disable=SC2086 — COMPOSE_FILES is intentionally word-split
  docker compose --env-file "$ENV_FILE" ${COMPOSE_FILES:-} exec -T server node -e "
    fetch('http://127.0.0.1:8787/healthz')
      .then(async (r) => {
        const body = await r.json();
        console.log(JSON.stringify(body));
        const good = body.ok === true && body.checks && body.checks.codex === 'ok';
        process.exit(good ? 0 : 1);
      })
      .catch((err) => { console.error(String(err)); process.exit(1); })"
}

while [[ "$tries" -gt 0 ]]; do
  if out=$(probe 2>/dev/null); then
    echo "healthz OK: $out"
    exit 0
  fi
  tries=$((tries - 1))
  sleep 5
done

echo "FAIL: /healthz never reached ok:true + codex:ok — last output:" >&2
probe || true
exit 1
