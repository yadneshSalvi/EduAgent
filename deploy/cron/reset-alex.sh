#!/usr/bin/env bash
# Nightly Alex reset (plans/08 §6): re-seed the shared demo account to its
# canonical state (preserving the User row + Clerk authId link), restart the
# server (it caches dashboards in memory — seeder doc), verify health.
# Scheduled AFTER 3am America/Los_Angeles (Alex's seeded timezone) so the
# streak math stays intact — see cron/crontab.example.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="${ENV_FILE:-.env.production}"
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

echo "== $(date -u +%FT%TZ) reseeding alex (--user alex --force)"
compose exec -T server sh -c \
  'cd /app/apps/server && ./node_modules/.bin/tsx src/seed/index.ts --user alex --force'

echo '== restarting server (drops in-memory dashboard caches; codex re-auths from auth.json)'
compose restart server
ENV_FILE="$ENV_FILE" ./deploy/healthcheck.sh 36

cat <<'EOF'
== WARM TURN — manual step (docs/DEPLOY_RUNBOOK.md, "Nightly reset")
Exam forks need a parent thread with a completed turn (Phase 4/5A findings:
thread/fork reads the parent ROLLOUT, and the seeder cannot fabricate one).
Open the demo as Alex once — Explore as Alex → tutor room → let the greeting
finish. Scripting this is brittle by design of the auth flow: demo-login
returns a Clerk sign-in token that must be exchanged via Clerk's frontend
API with browser cookies, so it stays a 60-second human step. If skipped,
nothing breaks — ThreadManager.forkForExam self-heals by running an awaited
greeting turn, so the first judge's "Take a mock exam" just waits longer.
EOF
