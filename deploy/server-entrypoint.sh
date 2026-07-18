#!/bin/sh
# Agent-host container entrypoint:
#   1. headless codex login (docs/PROTOCOL_NOTES.md §10 — env var alone does
#      NOT authenticate app-server; auth.json under CODEX_HOME does)
#   2. prisma migrate deploy against the /data volume
#   3. exec the server (tsx from source; index.ts owns SIGTERM shutdown)
#
# The API key is NEVER echoed: it enters codex via a pipe, login output is
# discarded (codex prints a key prefix on success), and the var is unset
# before the server process starts — auth.json is the only carrier.
set -eu

: "${DATA_DIR:=/data}"
export CODEX_HOME="${CODEX_HOME:-$DATA_DIR/codex-home}"
mkdir -p "$CODEX_HOME"

# Optional docker-secret style delivery: OPENAI_API_KEY_FILE=/run/secrets/...
if [ -n "${OPENAI_API_KEY_FILE:-}" ] && [ -f "${OPENAI_API_KEY_FILE}" ]; then
  OPENAI_API_KEY="$(cat "$OPENAI_API_KEY_FILE")"
  export OPENAI_API_KEY
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[entrypoint] FATAL: OPENAI_API_KEY (or OPENAI_API_KEY_FILE) is required for headless codex auth" >&2
  exit 1
fi

if printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 \
   && codex login status >/dev/null 2>&1; then
  echo "[entrypoint] codex authenticated (auth.json in CODEX_HOME=$CODEX_HOME)"
else
  echo "[entrypoint] FATAL: codex login --with-api-key failed (CODEX_HOME=$CODEX_HOME)" >&2
  exit 1
fi
unset OPENAI_API_KEY OPENAI_API_KEY_FILE

cd /app/apps/server
echo "[entrypoint] running prisma migrate deploy"
./node_modules/.bin/tsx scripts/prisma-env.ts migrate deploy

echo "[entrypoint] starting agent host"
exec ./node_modules/.bin/tsx src/index.ts
