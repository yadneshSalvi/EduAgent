# @eduagent/web

Next.js app for EduAgent (plans/04_frontend.md). Dark-first design system per plans/05_design_system.md.

## Ports & connectivity

- **`WEB_PORT`** (default `3000`): `pnpm dev` / `pnpm start` run Next on this port via `scripts/next-with-port.mjs`, which reads the repo-root `.env` (shell env wins). The agent host computes its CORS allowlist from the same `WEB_PORT`, so the two can never drift — change the port in ONE place (root `.env`) and both sides follow.
- **`NEXT_PUBLIC_SERVER_URL`** (optional override): base URL of the agent host, used by `src/lib/api.ts` (typed, credentialed, zod-parsed fetch) and for the WS URLs (`/ws?threadId=`, `/ws/user`). When unset, the base is derived **at runtime** from the page's own hostname + the default server port (`8787`) — so a tab opened on `localhost` talks to `localhost:8787` and one on `127.0.0.1` talks to `127.0.0.1:8787`. That keeps the session cookie same-site (mixing the two hosts makes the browser drop the `SameSite=Lax` cookie and every call 401s).
- **`NEXT_PUBLIC_SERVER_URL` is a BUILD-time value, not a runtime one.** Like every `NEXT_PUBLIC_*` var, it is inlined into the client bundle by `next build`; exporting it when you run `pnpm start` does nothing. If the agent host runs on a non-default port (anything other than `8787`) or a different host, the variable must be set **when building** (`NEXT_PUBLIC_SERVER_URL=http://localhost:9090 pnpm --filter @eduagent/web build`) — otherwise the runtime hostname fallback above kicks in and the app talks to port `8787`.
- All API calls use `credentials: 'include'`; the `AUTH_MODE=local` cookie session (or Clerk JWT) rides along automatically.

## Starting the app — always via the pnpm scripts

`pnpm dev` / `pnpm start` (or `pnpm --filter @eduagent/web dev|start` from the repo root) run Next through `scripts/next-with-port.mjs`, which loads the **repo-root `.env`** (including `AUTH_MODE` and `WEB_PORT`) before spawning `next`. Invoking `next dev` / `next start` directly skips that loader: the web process never sees `AUTH_MODE=local`, so ClerkProvider mounts and Clerk JS loads on every route even though the API side is local — logins break confusingly. If you need a one-off port, prefer `WEB_PORT=3300 pnpm start` over `next start -p 3300`.

## Auth modes

- `AUTH_MODE=local`: `/login` renders the profile picker (existing learners from `GET /auth/local-users` as one-click sign-ins, plus a new-handle form) → `POST /auth/local-login` sets the signed session cookie → redirect to `redirect_url` (same-origin only) or `/app`.
- Clerk mode (default): Clerk `<SignIn/>` + middleware; see `src/proxy.ts`.
- **`AUTH_MODE` must reach the WEB process too, not just the agent host** — the root layout and middleware read it to keep Clerk out of the tree entirely in local mode. Set it once in the repo-root `.env` (which `scripts/next-with-port.mjs` loads for both `dev` and `start`); if the web process doesn't see `AUTH_MODE=local`, ClerkProvider mounts and Clerk JS (with its dev-keys console warnings) loads on every route even though the API side is local.

## Dev harness

`/app/dev/turn-preview` (non-production only) replays scripted `WsEvent` fixtures (`src/lib/fixtures/turn-preview.ts`) through the same `turnStreamReducer` + components as the live tutor room: streaming markdown, reasoning preview, activity chips, the memory-commit toast, and the Diff Drawer. `/app/onboarding?preview=1` does the same for the onboarding interview — including the embedded baseline quiz (answer it to see the graded reply) — and the "memory born" finale.

The fixtures double as test data — `src/hooks/use-turn-stream.test.ts` asserts every fixture event against the shared `wsEventSchema`.

## Notes

- The Monaco diff editor (`@monaco-editor/react`) loads its assets from the jsdelivr CDN at runtime (the library default) — the Diff Drawer needs network access the first time it opens.
- `pnpm test` runs the unit tests (reducer, diff parser, api client error paths, commit formatting).
