# Codex app-server protocol types

`generated/` is emitted verbatim by the Codex CLI (pinned `codex-cli 0.144.4`, the version the
Phase 0 spike validated — see `docs/PROTOCOL_NOTES.md`):

```sh
codex app-server generate-ts --out packages/shared/src/protocol/generated
```

- **Never hand-edit `generated/`** — regenerate it on every CLI version bump instead.
- `index.ts` is the only hand-written file: it re-exports the generated surface as
  `@eduagent/shared/protocol` (subpath export; not part of the package root).
- Request/response/notification unions live in `generated/ClientRequest.ts`,
  `generated/ServerRequest.ts`, `generated/ServerNotification.ts`; the v2 method
  params/results (e.g. `ThreadStartParams`, `TurnStartParams`, `SandboxPolicy`) are under
  `generated/v2/` and re-exported as the `v2` namespace.
- Only `apps/server/src/codex/` may depend on these types (plans/03 §2); observed wire
  behavior (what actually fires, in what order) stays documented in `docs/PROTOCOL_NOTES.md`.
- `generated/` is excluded from ESLint and Prettier (machine-formatted output).
