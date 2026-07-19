# DEPLOY RUNBOOK — bare Ubuntu 24.04 → live `eduagent.aiquantized.com`

Executable end-to-end in under an hour by anyone (you-next-session, the user,
another agent). Spec: `plans/08_deployment.md`. Protocol ground truth:
`docs/PROTOCOL_NOTES.md` (§10 headless auth; Phase 1 addendum: Landlock
`writableRoots: [.git]` **must be re-verified on Linux** — step 7).

Deploy artifacts map:

| Artifact | Purpose |
|---|---|
| `docker-compose.yml` | caddy + web + server, one `eduagent-data` volume |
| `docker-compose.local.yml` | dev-machine smoke test (HTTP :8080, dummy key) |
| `docker-compose.seccomp.yml` | sandbox decision-tree branch 2 override |
| `deploy/Dockerfile.web` / `deploy/Dockerfile.server` | images (server pins codex-cli **0.144.4** via npm `@openai/codex`) |
| `deploy/server-entrypoint.sh` | headless codex login → migrate → boot |
| `deploy/caddy/Caddyfile` | TLS + path routing (`/api,/auth,/ws,/healthz` → server) |
| `deploy/deploy.sh` / `rollback.sh` / `healthcheck.sh` | deploy flow + rollback |
| `deploy/backup.sh`, `deploy/cron/*` | nightly Alex reset + backups |
| `.env.production.example` | every required variable, documented |

---

## 1. Provision the VPS

- Hetzner **CPX31** (4 vCPU / 8 GB) or DO 8 GB droplet, **US region** (API
  latency), **Ubuntu 24.04 LTS** (kernel 6.8 → Landlock available).
- Add your SSH public key at creation. Note the IPv4 address.
- **DNS now** (propagation runs while you work): in the `aiquantized.com`
  zone, add `A eduagent → <VPS-IP>`. Verify before step 6:
  `dig +short eduagent.aiquantized.com` → must print the VPS IP.

## 2. User + SSH hardening

SSH in as root, then:

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
rsync -a ~/.ssh/ /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy

# Keys only, no root login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/;s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Reconnect as `deploy@` before continuing (verify you can, in a NEW terminal,
before closing the root session).

## 3. Firewall

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw allow 443/udp   # HTTP/3
sudo ufw --force enable && sudo ufw status
```

The relay port (8788) and internal ports 3000/8787 are never published by
compose — nothing further to close.

## 4. Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
newgrp docker          # or log out/in
docker version && docker compose version   # compose v2.24+ required
```

## 5. Clone + configure

```sh
sudo mkdir -p /opt/eduagent && sudo chown deploy:deploy /opt/eduagent
git clone https://github.com/<org>/EduAgent.git /opt/eduagent
cd /opt/eduagent
cp .env.production.example .env.production
chmod 600 .env.production
"${EDITOR:-nano}" .env.production
```

Fill in **every** variable (the example documents each):

| Var | Value |
|---|---|
| `SITE_ADDRESS` | `eduagent.aiquantized.com` |
| `PUBLIC_ORIGIN` / `APP_ORIGIN` | `https://eduagent.aiquantized.com` |
| `OPENAI_API_KEY` | dedicated key **with a hard budget cap** (plans/08 §3) |
| `ACCESS_CODE` | judge access code (goes in Devpost testing instructions only). Server **fails closed** (503 on demo-login) if unset |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `AUTH_MODE` | `clerk` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk **production** instance keys |
| `LOG_LEVEL` | `info` |

## 6. First deploy

Confirm DNS first (`dig +short eduagent.aiquantized.com` = VPS IP — Caddy
needs it to pass the ACME challenge), then:

```sh
cd /opt/eduagent && ./deploy/deploy.sh
```

The script: pulls, tags previous images `:prev`, builds both images
(~5–10 min first run), `up -d`, then polls `/healthz` **inside** the server
container until `{ok:true, checks:{db:"ok", codex:"ok"}}` — codex:ok proves
the headless login incantation (`printenv OPENAI_API_KEY | codex login
--with-api-key` under `CODEX_HOME=/data/codex-home`) worked. Then browse
`https://eduagent.aiquantized.com` — landing page over valid TLS.

Seed the demo users (first deploy only — nightly cron maintains alex after):

```sh
docker compose --env-file .env.production exec -T server sh -c \
  'cd /app/apps/server && ./node_modules/.bin/tsx src/seed/index.ts'
docker compose --env-file .env.production restart server   # drop dashboard caches
./deploy/healthcheck.sh
```

**Post-deploy upgrade note:** after deploying a workspace-shape change such as tracks/roadmaps,
reseed Alex immediately with `ENV_FILE=.env.production ./deploy/cron/reset-alex.sh`. The seeder
generates the new directory layout natively; there is no runtime migration for an older demo
workspace. This preserves Alex's linked User row and does not change the nightly reset schedule.

## 7. Sandbox decision tree (plans/08 §4) — RUN THIS BEFORE ANNOUNCING THE URL

Codex's Linux sandbox is Landlock/seccomp; Docker's seccomp profile may block
it. Take the FIRST branch that passes, then **record the winning branch +
evidence in this file and the README** so self-hosting judges inherit it.

**The probe** (used by every branch) — write-inside allowed, write-outside
denied, network denied; judge by **effects on disk**, never the model's
narrative (PROTOCOL_NOTES §6 caveat):

```sh
docker compose --env-file .env.production exec -T server bash -c '
  set -e
  W=$(mktemp -d); cd "$W" && git init -q .
  codex exec --skip-git-repo-check --sandbox workspace-write -C "$W" \
    "Run exactly these three shell commands and show each result:
     (1) printf SANDBOX-OK > probe-inside.txt
     (2) printf escaped > /probe-escape.txt
     (3) curl -sS --max-time 5 https://example.com" || true
  echo "--- verdict (files, not narrative) ---"
  [ -f "$W/probe-inside.txt" ] && echo "PASS: inside write worked" || echo "FAIL: inside write blocked"
  [ ! -f /probe-escape.txt ] && echo "PASS: outside write blocked" || echo "FAIL: SANDBOX ESCAPE — outside write landed"
'
```

Interpretation:
- **All three PASS lines** → sandbox healthy under the default Docker seccomp
  profile. → **Branch 1 done.** Record it; skip to step 8.
- **Inside write FAILS with a Landlock/`operation not permitted` error at
  sandbox SETUP** (codex stderr mentions `landlock`/`seccomp`/`Sandbox
  error`) → the runtime blocks Landlock syscalls → **branch 2**.
- **Outside write LANDS** → sandbox silently absent → treat as failure,
  **branch 2** (never ship a live URL in this state).

### Branch 2 — custom seccomp profile

```sh
mkdir -p deploy/seccomp
curl -fsSL https://raw.githubusercontent.com/moby/moby/master/profiles/seccomp/default.json \
  -o /tmp/docker-default-seccomp.json
jq '.syscalls += [{"names":["landlock_create_ruleset","landlock_add_rule","landlock_restrict_self"],"action":"SCMP_ACT_ALLOW"}]' \
  /tmp/docker-default-seccomp.json > deploy/seccomp/codex-landlock.json
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.seccomp.yml up -d server
```

Re-run the probe (add `-f docker-compose.seccomp.yml` to the exec). Green →
done: commit `deploy/seccomp/codex-landlock.json` + note here; all future
deploys must include the seccomp override file.

### Branch 3 — agent host native on the VM (systemd), caddy+web stay in Docker

Zero sandbox risk (native Landlock works on Ubuntu 24.04), messier ops:

1. On the VPS: install Node 22 (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git`), `sudo corepack enable`, `sudo npm i -g @openai/codex@0.144.4`.
2. `cd /opt/eduagent && pnpm install --frozen-lockfile --filter @eduagent/server... --filter @eduagent/mcp-ui-tools...`
3. Env: root `.env` (NOT .env.production — the native server reads `.env`) with the same server vars plus `DATA_DIR=/opt/eduagent-data`, `CODEX_HOME=/opt/eduagent-data/codex-home`, `NODE_ENV=production`, `SERVER_HOST=0.0.0.0`.
4. Headless auth once: `export CODEX_HOME=/opt/eduagent-data/codex-home && printenv OPENAI_API_KEY | codex login --with-api-key` (key exported only in that shell).
5. systemd unit `/etc/systemd/system/eduagent-server.service`: `WorkingDirectory=/opt/eduagent/apps/server`, `ExecStartPre=./node_modules/.bin/tsx scripts/prisma-env.ts migrate deploy`, `ExecStart=./node_modules/.bin/tsx src/index.ts`, `Restart=always`, `User=deploy`, `Environment=NODE_ENV=production`.
6. Point Caddy at the host: compose override with `services.caddy.environment.SERVER_UPSTREAM: host.docker.internal:8787` and `services.caddy.extra_hosts: ["host.docker.internal:host-gateway"]`; stop the server container (`docker compose stop server` — or comment the service out).
7. `sudo ufw deny 8787` stays implicit (deny-incoming default); re-run the probe natively (same probe body, no `docker compose exec` wrapper).

### Branch 4 — LAST RESORT: `dangerFullAccess` inside a hardened container

The codex sandbox is disabled; the **container becomes the sandbox**.
Requires a deliberate one-line server change (no env knob exists, on
purpose): `SANDBOX_POLICY_BASE` in `apps/server/src/codex/AppServerClient.ts`
→ `{type:"dangerFullAccess"}`. Then harden the server service: `cap_drop:
[ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true` +
`tmpfs: [/tmp]` with only `/data` writable, and egress restricted to the
OpenAI API (ufw/iptables on the docker bridge). **Document the tradeoff
honestly in the README** (per plans/08 §4) and record it here.

### Landlock `writableRoots: [.git]` re-verification (Phase 1 addendum — REQUIRED)

`workspaceWrite` marks the workspace's top-level `.git` read-only; the
macOS-verified workaround grants `writableRoots: [<workspace>/.git]` on every
turn (`ThreadManager.ts` ~line 667). Verify the Linux/Landlock behavior on
the winning branch: sign in (fresh profile or alex), send a tutor message
that produces a learning event (e.g. finish onboarding or answer a quiz),
then check the memory commit actually landed:

```sh
docker compose --env-file .env.production exec -T server sh -c \
  'for w in /data/workspaces/*; do echo "$w"; git -C "$w" log --oneline -3; done'
```

New commit(s) authored by `EduAgent <agent@eduagent.local>` after your turn →
PASS (record here). No commits + server logs showing `.git/index.lock`
EPERM → Landlock ignores the workaround → escalate: the fallback is
server-side commits (see PROTOCOL_NOTES Phase 1 addendum hardening options)
— stop and coordinate before demoing exam mode.

## 8. Nightly ops (cron)

```sh
sudo mkdir -p /var/log/eduagent && sudo chown deploy /var/log/eduagent
crontab -e    # paste from deploy/cron/crontab.example (10:45 UTC reset, 11:15 UTC backup)
```

- `reset-alex.sh` re-seeds alex (preserves User row + Clerk link), restarts
  the server, verifies health, and prints the **manual warm-turn reminder**:
  open the demo as Alex once so the learn thread has a completed greeting
  turn (exam forks need a parent rollout; skipping only costs the first
  judge's exam an extra wait — `forkForExam` self-heals).
- `backup.sh` tars the `/data` volume to `/var/backups/eduagent`, keeps 7.

## 9. Monitoring

UptimeRobot (free): HTTP(S) monitor on
`https://eduagent.aiquantized.com/healthz`, keyword alert on `"ok":true`
absent, 5-min interval, email alerts. The box must not die silently during
judging (Jul 22 – Aug 5).

## 10. Snapshot points (provider snapshots + `deploy/backup.sh`)

1. After first green deploy + sandbox tree recorded.
2. **Before video recording day.**
3. **Immediately before submission** — then tag `submission` and freeze
   deploys (only critical fixes from that tag during judging, plans/08 §7).

## 11. Routine operations

| Action | Command |
|---|---|
| Deploy | `./deploy/deploy.sh` (or `DEPLOY_HOST=deploy@<vps> ./deploy/deploy.sh` from a workstation) |
| Rollback | `./deploy/rollback.sh` (`:prev` images; `IMAGE_TAG=<sha>` for older) |
| Health | `./deploy/healthcheck.sh` or `curl -s https://eduagent.aiquantized.com/healthz` |
| Logs | `docker compose --env-file .env.production logs -f server` |
| Manual reseed | `ENV_FILE=.env.production ./deploy/cron/reset-alex.sh` |
| Manual backup | `./deploy/backup.sh` |

## Recorded decisions (fill in during first deploy)

- **Sandbox branch:** _pending — run step 7 on the VPS_
- **Landlock `.git` writableRoots:** _pending — verified on macOS Seatbelt
  only (PROTOCOL_NOTES Phase 1 addendum)_
- **Local compose smoke test (2026-07-18, macOS Docker Desktop, arm64):** see
  "Local smoke test findings" below.

## Local smoke test findings (2026-07-18, macOS Docker Desktop 28.3.2, arm64)

_Recorded by Phase 5C; the VPS re-runs (step 7) are the ones that count._
Invocation: see `docker-compose.local.yml` header. All green unless noted:

- Both images build (linux/arm64). Server image carries `codex-cli 0.144.4`
  (npm `@openai/codex@0.144.4`).
- Entrypoint chain works in-container: headless login (`printenv
  OPENAI_API_KEY | codex login --with-api-key`, dummy key) → `auth.json`
  under `/data/codex-home` → migrate deploy → boot. `/healthz` through Caddy:
  `{"ok":true,"checks":{"db":"ok","codex":"ok"}}`; boot asserts passed
  (skills `teach`/`memory` visible, all 9 `ui_*` MCP tools listed); server
  bound `0.0.0.0` under `NODE_ENV=production`.
- Seeder in-container: alex 140+ commits + sam, 10.1s. Alex login through
  Caddy (`AUTH_MODE=local`): cookie session → `/api/dashboard` returns the
  seeded payload. WS `/ws/user` upgrades through the proxy (ping→pong).
- **Sandbox under Docker Desktop: Landlock is IMPOSSIBLE there** — the
  LinuxKit VM kernel (`6.10.14-linuxkit`) has `CONFIG_SECURITY_LANDLOCK is
  not set`; active LSMs are only `capability,bpf`. No seccomp profile can
  fix an absent kernel feature, so branches 1–2 can only be judged on the
  VPS (Ubuntu 24.04 ships Landlock in its default `lsm=` list). Expect
  agent turns that execute commands to fail sandbox setup if run under
  Docker Desktop locally (not exercised — smoke test uses a dummy key).
- `codex debug` on 0.144.4 has **no** landlock/sandbox subcommand (only
  `models` / `app-server` / `prompt-input`) — the step 7 probe therefore
  goes through `codex exec`, which needs a real API key.

## 12. Demo login ("Explore as Alex") — deploy-day activation (Phase 5D)

The full ticket round-trip (access code → `POST /auth/demo-login` → Clerk
sign-in token → `signIn.ticket()` in the browser → `/app` as Alex) was proven
locally on 2026-07-18 against the **dev** Clerk instance (`pk_test_`). The
production instance is domain-bound, so repeat the proof once on the real
origin:

1. `.env.production` must set `ACCESS_CODE`, the `pk_live_`/`sk_live_` Clerk
   keys, `DAILY_TURN_QUOTA=60`, `RATE_LIMITS=1` (all in
   `.env.production.example`).
2. In the Clerk dashboard the **production instance** must have
   `eduagent.aiquantized.com` as its app domain (DNS + certs per Clerk's
   production checklist). No extra allowed-origin config was needed for the
   ticket strategy on the dev instance.
3. After the first seed, mint once from a workstation:
   `curl -sX POST https://eduagent.aiquantized.com/auth/demo-login -H 'content-type: application/json' -d '{"accessCode":"<the code>"}'`
   → expect `{token, userId}`. This creates AND links the **production**
   standing Clerk user (the dev instance's standing user is
   `user_3GfEv7w07YTEzKY6xCClas2xVyj` — per-instance, not reused). Record the
   prod `userId` here: _pending_.
4. Browser proof on the real origin: `/login` → access code → "Enter the
   demo" → dashboard shows "Welcome back, Alex". This also runs the warm
   greeting turn §8 asks for after resets.
5. Resilience notes: the nightly reset preserves `User.authId`, and even a
   from-scratch DB **relinks automatically** — demo-login looks the standing
   user up by its unique demo email (`alex.demo@eduagent.aiquantized.com`)
   before ever creating one. A judge already signed into a personal Clerk
   session may hit the single-session edge (clerk/javascript#8219) — the card
   surfaces a clean error; sign out of the personal session first.
6. Rate-limit smoke: 11 rapid demo-login POSTs from one IP → the 11th is 429;
   `/healthz` stays unthrottled for UptimeRobot. Quota smoke (optional):
   set `DAILY_TURN_QUOTA=1`, send two chat messages as a throwaway profile —
   the second must show the terminal daily-limit error, then restore 60.
