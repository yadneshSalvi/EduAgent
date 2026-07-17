# @eduagent/web

Next.js app for EduAgent (plans/04_frontend.md). Dark-first design system per plans/05_design_system.md.

## Ports & connectivity

- **`WEB_PORT`** (default `3000`): `pnpm dev` / `pnpm start` run Next on this port via `scripts/next-with-port.mjs`, which reads the repo-root `.env` (shell env wins). The agent host computes its CORS allowlist from the same `WEB_PORT`, so the two can never drift — change the port in ONE place (root `.env`) and both sides follow.
- **`NEXT_PUBLIC_SERVER_URL`** (default `http://localhost:8787`): base URL of the agent host, used by `src/lib/api.ts` (typed, credentialed, zod-parsed fetch) and for the WS URLs (`/ws?threadId=`, `/ws/user`). Inlined at build time — set it before `next build` for non-default setups.
- All API calls use `credentials: 'include'`; the `AUTH_MODE=local` cookie session (or Clerk JWT) rides along automatically.

## Auth modes

- `AUTH_MODE=local`: `/login` renders the profile picker → `POST /auth/local-login` sets the signed session cookie → redirect to `redirect_url` (same-origin only) or `/app`.
- Clerk mode (default): Clerk `<SignIn/>` + middleware; see `src/proxy.ts`.

## Dev harness

`/app/dev/turn-preview` (non-production only) replays scripted `WsEvent` fixtures (`src/lib/fixtures/turn-preview.ts`) through the same `turnStreamReducer` + components as the live tutor room: streaming markdown, reasoning preview, activity chips, the memory-commit toast, and the Diff Drawer. `/app/onboarding?preview=1` does the same for the onboarding interview and the "memory born" finale.

The fixtures double as test data — `src/hooks/use-turn-stream.test.ts` asserts every fixture event against the shared `wsEventSchema`.

## Notes

- The Monaco diff editor (`@monaco-editor/react`) loads its assets from the jsdelivr CDN at runtime (the library default) — the Diff Drawer needs network access the first time it opens.
- `pnpm test` runs the unit tests (reducer, diff parser, api client error paths, commit formatting).
