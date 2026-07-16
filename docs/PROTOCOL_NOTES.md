# PROTOCOL_NOTES — `codex app-server` observed wire reality

**This file is the protocol source of truth for all EduAgent work** (per plans/00 §11, plans/03 §2). Everything below was observed empirically on this machine by `scripts/spike-appserver.mjs` against the real binary — not copied from docs. Raw captures live in `scripts/fixtures/appserver/*.jsonl` (one file per spike step; every inbound message, API key scrubbed).

| Fact | Value |
|---|---|
| CLI version (pin this) | `codex-cli 0.144.4` |
| Node | v22.22.3 |
| Platform observed | macOS (darwin arm64); protocol is platform-independent, sandbox impl is not (§7) |
| Spike date | 2026-07-17 |
| **GPT-5.6 model id** | **`gpt-5.6-sol`** (see §9) |
| Spike status | 14/14 steps green, twice in a row |

**Bonus discovery — typed bindings for free:** the CLI can emit its own protocol schema. Lock `packages/shared` protocol types against these instead of hand-writing them:

```sh
codex app-server generate-ts --out <dir>          # TypeScript types for every method/notification
codex app-server generate-json-schema --out <dir> # same as JSON Schema (v1/ + v2/ per-message files)
```

---

## 1. Wire framing

- Newline-delimited JSON (JSONL) over stdio. One JSON object per line, no `Content-Length` headers.
- JSON-RPC 2.0 shapes **without the `"jsonrpc":"2.0"` field, in both directions** (confirmed: server messages omit it; our requests omitting it are accepted).
- Requests: `{id, method, params}` (integer ids fine). Responses: `{id, result}` or `{id, error:{code, message, data?}}`.
- Notifications: `{method, params}` (no `id`).
- **Server→client requests exist** (they carry `method` AND `id`): the client MUST respond or the turn hangs. Under our config the only one observed is `mcpServer/elicitation/request` (§8). Approval requests (`item/commandExecution/requestApproval` etc.) never fired under `approvalPolicy:"never"`.
- Any request before `initialize` fails with `{"code":-32600,"message":"Not initialized"}`.

## 2. Handshake & lifecycle

```jsonc
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"eduagent","title":"EduAgent","version":"0.1.0"}}}
← {"id":1,"result":{"userAgent":"eduagent/0.144.4 (Mac OS 26.5.2; arm64) vscode/3.11.13 (eduagent; 0.1.0)",
                    "codexHome":"/abs/path/to/CODEX_HOME","platformFamily":"unix","platformOs":"macos"}}
→ {"method":"initialized","params":{}}   // notification, required before further calls
```

- `initialize.params.capabilities` (optional): `{experimentalApi?, optOutNotificationMethods?: string[], …}` — we did not need any.
- Boot-time notifications to expect and ignore: `remoteControl/status/changed`, `thread/goal/cleared`, `mcpServer/startupStatus/updated`, occasionally `warning {threadId?, message}`.
- Kill the child with SIGTERM; it exits cleanly (no orphan processes observed across 5 spike runs).

## 3. Methods we use (as actually called; fixture = `scripts/fixtures/appserver/<step>.jsonl`)

| Method | Params we send | Result (observed shape) | Fixture |
|---|---|---|---|
| `initialize` | `{clientInfo:{name,title,version}}` | `{userAgent, codexHome, platformFamily, platformOs}` | 01 |
| `model/list` | `{limit:100}` | `{data: Model[], nextCursor}` — Model: `{id, model, displayName, isDefault, hidden, defaultReasoningEffort, supportedReasoningEfforts:[{reasoningEffort,description}]}` | 02 |
| `thread/start` | `{cwd, model, sandbox:"workspace-write", approvalPolicy:"never", developerInstructions}` | `{thread:{id,…}, model, cwd, sandbox: SandboxPolicy, approvalPolicy, approvalsReviewer, modelProvider, instructionSources[]}` | 03 |
| `turn/start` | `{threadId, input:[{type:"text",text}], sandboxPolicy?, effort?, summary?, model?}` | **returns immediately**: `{turn:{id, items:[], itemsView:"notLoaded", status:"inProgress", error:null, startedAt:null,…}}`; completion arrives via `turn/completed` notification | 04 |
| `thread/resume` | `{threadId}` | same shape as `thread/start` result (thread reloaded from disk) | 06 |
| `thread/fork` | `{threadId}` (optional `lastTurnId` to fork through) | same shape; **new** `thread.id` | 07 |
| `mcpServerStatus/list` | `{}` | `{data:[{name, serverInfo:{name,version,…}, tools:{<toolName>: {name, description, inputSchema}}, …}]}` | 08 |
| `skills/list` | `{cwds:[dir], forceReload:true}` | `{data:[{cwd, skills:[{name, description, path, …}]}]}` (one entry per cwd) | 09 |
| `turn/interrupt` | `{threadId, turnId}` | `{}` ; then `turn/completed` fires with `turn.status:"interrupted"` | 10 |
| `account/read` | `{}` | `{account: null \| {...}, requiresOpenaiAuth: bool}` — handy auth healthcheck | 11 |

Notes:
- Thread ids and turn ids are UUIDv7 strings.
- `turn/start` params it does **not** have: `developer_instructions` / `developerInstructions`. Instructions are thread-level (§11 D2).
- Per-turn overrides that DO exist on `turn/start`: `model`, `effort`, `summary` (`"auto"|"concise"|"detailed"|"none"`), `cwd`, `sandboxPolicy`, `approvalPolicy`, `personality`, `outputSchema` (JSON-schema-constrained final message!), `clientUserMessageId`.
- Other methods that exist and may be useful later: `thread/list`, `thread/read`, `thread/name/set`, `thread/compact/start`, `thread/rollback`, `turn/steer`, `review/start`, `command/exec` (client-initiated exec in the thread sandbox), `fuzzyFileSearch`, `config/read`, `account/rateLimits/read`. Full catalog: 87 client methods in the generated schema.

## 4. Notification stream (what a turn actually looks like)

Observed for a simple message turn (fixture 04):

```
thread/status/changed {status:{type:"active",activeFlags:[]}}
turn/started          {threadId, turn:{id, status:"inProgress", startedAt}}
item/started          {item:{type:"userMessage", id, content:[{type:"text",text,…}]}, threadId, turnId, startedAtMs}
item/completed        {item:{type:"userMessage", …}}
item/started          {item:{type:"agentMessage", id, text:"", phase:"final_answer"}}
item/agentMessage/delta {threadId, turnId, itemId, delta:"pon"}   // token stream
item/completed        {item:{type:"agentMessage", id, text:"pong", phase:"final_answer"}}
thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total:{totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}, last:{…}, modelContextWindow}}
thread/status/changed {status:{type:"idle"}}
turn/completed        {threadId, turn:{id, status:"completed", error:null, startedAt, completedAt, durationMs}}
```

Key item shapes (fixture 05a):

- `agentMessage`: `{type, id, text, phase: "commentary"|"final_answer", memoryCitation}` — the model often emits a short *commentary* message ("I'll create the file…") before tool use, then a *final_answer* message. Both stream via `item/agentMessage/delta`. **UI should render both but may style commentary differently.**
- `commandExecution`: `{type, id, command:"/bin/zsh -lc 'cat hello.txt'", cwd, processId, source, status:"completed"|"failed"|…, commandActions:[{type:"read"|…, command, name, path}], aggregatedOutput, exitCode, durationMs}`. Streaming output arrives via `item/commandExecution/outputDelta`.
- `fileChange`: `{type, id, changes:[{path, kind:{type:"add"|…}, diff}], status}` — plus a turn-level `turn/diff/updated {threadId, turnId, diff}` carrying a full git-style unified diff of the turn so far.
- `mcpToolCall`: `{type, id, server, tool, status:"inProgress"→"completed"|"failed", arguments, result, error, durationMs}`.
- `reasoning`: `{type, id, summary:[], content:[]}` item — at default settings the summary array stayed **empty**.
- Reasoning deltas: `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta` exist in the schema; observation at `effort:"medium", summary:"detailed"`: see §12 (filled from the final green runs).
- `turn/completed.turn.items` is `[]` with `itemsView:"notLoaded"` — do NOT read items from it; accumulate from `item/completed` events (or `thread/read`).
- Token usage: there is no usage field on `turn/completed`; use `thread/tokenUsage/updated` (cumulative `total` + per-request `last`, plus `modelContextWindow` = 353,400 for gpt-5.6-sol).
- Interrupt: `turn/interrupt` → response `{}` → `turn/completed` with `status:"interrupted"` (fixture 10). Partial `item/agentMessage/delta`s simply stop; no special "aborted item" event was observed.

## 5. Threads: resume & fork (both work on 0.144.4)

- Sessions persist under `$CODEX_HOME/sessions` automatically (don't pass `ephemeral:true`, which would disable that).
- **Resume after process death works**: we SIGKILL-ed the app-server, respawned, `thread/resume {threadId}`, and the model correctly recalled facts from before the kill (fixture 06).
- **Fork works**: `thread/fork {threadId}` returns a new thread that sees the full parent history (fixture 07) — the exam-mode design is safe.

## 6. Sandbox & approvals

- Thread-level `sandbox` is a **mode string**: `"read-only" | "workspace-write" | "danger-full-access"`.
- The **structured** policy lives at turn level (`turn/start.sandboxPolicy`, persists for subsequent turns) — this is what we actually use:

```jsonc
{"type":"workspaceWrite","networkAccess":false,
 "excludeSlashTmp":true,"excludeTmpdirEnvVar":true,"writableRoots":[]}
```

- ⚠️ **Defaults gotcha:** `workspaceWrite` defaults to `excludeSlashTmp:false, excludeTmpdirEnvVar:false` — i.e. **`/tmp` and `$TMPDIR` are agent-writable by default**. EduAgent must pass both excludes (as above), or exercise files written to /tmp would escape the per-user workspace story.
- Denial is real and OS-level: with the policy above, `printf escaped > /tmp/spike-escape.txt` inside the agent's shell fails with `zsh: operation not permitted` (macOS Seatbelt), the file is not created, and the failure text is visible to the model in `aggregatedOutput` so it can explain itself (fixture 05b). No approval round-trip occurs under `approvalPolicy:"never"` — escalation is simply skipped.
- `approvalPolicy` values: `"untrusted" | "on-request" | "never"` or a granular object `{granular:{mcp_elicitations,rules,sandbox_approval,request_permissions?,skill_approval?}}` (untested).
- Caveat: a model may *claim* a write was blocked without attempting it (observed once). For grading-critical assertions, verify effects on disk, never trust the narrative.

## 7. Sandbox portability note (for plans/08 §4)

The spike ran on macOS (Seatbelt). On the Ubuntu VPS the sandbox is Landlock/seccomp — the Docker decision tree in plans/08 §4 still needs its own spike during Phase 5; nothing here validates Linux-in-Docker.

## 8. MCP registration & the elicitation surprise

**Registration mechanism (verified):** plain `-c` config overrides on the spawn command line — no config file needed, no restart mechanism required:

```sh
codex app-server \
  -c 'mcp_servers.<name>.command="node"' \
  -c 'mcp_servers.<name>.args=["/abs/path/server.mjs"]'
```

- Server shows up in `mcpServerStatus/list` (with tool schemas) and its tools are callable by the model. Round-trip verified with a hand-rolled zero-dep stdio MCP server (`scripts/spike-mcp-server.mjs`; MCP wire **does** require `"jsonrpc":"2.0"`, unlike the app-server wire).
- ⚠️ **Plan-breaking finding, resolved:** `approvalPolicy:"never"` does **NOT** auto-approve MCP tool calls. Each call triggers a server→client request:

```jsonc
← {"id":0,"method":"mcpServer/elicitation/request","params":{threadId, turnId, serverName, mode:"form",
     "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"], tool_description, tool_params, …}}}
→ {"id":0,"result":{"action":"accept"}}   // "accept" | "decline" | "cancel"
```

  If the client doesn't answer (or declines), the item completes as `status:"failed", error:{message:"user rejected MCP tool call"}` and the model sees "user rejected MCP tool call". `-c mcp_servers.<name>.trusted=true` did **not** suppress the elicitation on 0.144.4.
- **Consequence for the agent host:** `AppServerClient` MUST handle `mcpServer/elicitation/request` and auto-accept when `_meta.codex_approval_kind === "mcp_tool_call"` (and `serverName` is our ui-tools server); the `_meta.persist` field suggests session-level persistence may be possible via response `_meta`, but plain per-call accept works and is what we verified. Thread status flips to `activeFlags:["waitingOnApproval"]` while waiting — surface as an activity chip, never a dead spinner.

## 9. Models (fixture 02)

`model/list` returned exactly these ids: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`.

- **There is no bare `gpt-5.6`** — GPT-5.6 ships as three variants. **`gpt-5.6-sol` is `isDefault:true`** (defaultReasoningEffort `"low"`); terra/luna default to `"medium"`.
- **Decision: `CODEX_MODEL=gpt-5.6-sol`.** All three variants support efforts `low|medium|high|xhigh|max` (+`ultra` on sol: "maximum reasoning with automatic task delegation").
- Context window (from `thread/tokenUsage/updated.modelContextWindow`): 353,400 tokens.

## 10. Headless / non-interactive auth (for plans/08 §3)

- **`OPENAI_API_KEY` as an env var on the app-server process does NOT authenticate it** on 0.144.4. Turns fail (`turn.status:"failed"`) with `codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:401}}` after retries, and a `warning` notification shows the WS 401. `account/read` under env-only shows `{account:null, requiresOpenaiAuth:true}` — use that as the healthcheck probe.
- **The working incantation** (verified — the entire spike runs on it, in an isolated `CODEX_HOME`, never touching `~/.codex`):

```sh
export CODEX_HOME=/path/to/app-codex-home   # isolate from any user config
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status                          # "Logged in using an API key - sk-…"
```

  This writes `$CODEX_HOME/auth.json` with keys `{auth_mode, OPENAI_API_KEY}` (mode `apikey`). After that, `codex app-server` spawned with the same `CODEX_HOME` is fully authenticated **with no key in its process env**. For the Ubuntu deploy: run the login line once at container start before booting the agent host.

## 11. Skills

- Wire name is **`skills/list`** (not `skillsList`), params `{cwds:[…], forceReload:bool}`, result `{data:[{cwd, skills:[{name, description, path,…}]}]}`.
- **Installation location verified:** dropping `<workspace>/.codex/skills/<name>/SKILL.md` (YAML frontmatter `name:`/`description:` + body) makes it appear in `skills/list` for that cwd immediately with `forceReload:true`. This is the per-user-workspace mechanism plans/01 §4.6 hoped for — it works.
- ⚠️ Discovery also **walks up ancestor directories**: from a workspace nested inside this repo, skills from the repo root (`EduAgent/.agents/skills/…`) were listed too. Since `data/workspaces/<userId>/` lives inside the repo, any repo-level skills leak into every user's tutor. Either keep the repo free of root-level `.codex/skills`/`.agents/skills` dirs, or accept/curate the leak. (An `.agents/skills/agent-browser` dir currently exists at the repo root — from a dev tool install; harmless but visible to agents.)
- Whether the *model* invokes an installed skill correctly is a Phase 1 concern (prompting), but listing + location are settled. `skills/config/write` and `skills/extraRoots/set` exist if we ever need explicit roots.

## 12. Reasoning-preview events (plans/01 §4.3 question)

At default settings (effort low, summary auto) GPT-5.6-sol emitted **no** reasoning text at all — `reasoning` items appear with empty `summary`/`content`, and neither `item/reasoning/summaryTextDelta` nor `item/reasoning/textDelta` fired.

With `effort:"medium", summary:"detailed"` on `turn/start`, the model emits **`item/reasoning/summaryPartAdded`** and **`item/reasoning/summaryTextDelta`** `{threadId, turnId, itemId, summaryIndex, delta}` — but **not deterministically**: across the two final green runs, one run streamed summaries, the other reasoned too briefly to produce any. Raw `item/reasoning/textDelta` was never observed (summaries only for this model family).

**Consequence:** the "reasoning preview" latency mask cannot rely on reasoning deltas alone. The reliable early signal is the commentary-phase `agentMessage` (§4), which streams within a couple of seconds on tool-using turns; treat reasoning summaries as a bonus stream when present.

## 13. Discrepancies vs plans/ (the section later phases must read)

| # | plans/ said | Observed reality | Impact |
|---|---|---|---|
| D1 | `CODEX_MODEL=gpt-5.6` (plans/01 §6, §2) | No such id; use **`gpt-5.6-sol`** (default; siblings `-terra`, `-luna`) | Update env default + healthcheck assertion |
| D2 | `turn/start` carries `settings.developer_instructions` per turn (plans/01 §4.3, plans/03 §3.1) | **No per-turn developer instructions exist.** `developerInstructions` is a param of `thread/start` / `thread/resume` / `thread/fork` (camelCase, thread-level). Per-turn knobs are `model/effort/summary/sandboxPolicy/approvalPolicy/personality/outputSchema` only | ThreadManager must set mode instructions at thread creation; per-turn context (state digest, session token refresh, mode switches) must be injected as part of the user input text, via `thread/resume` with new `developerInstructions`, or via separate threads per mode (our design already uses thread-per-mode — fits) |
| D3 | `approvalPolicy:"never"` ⇒ fully autonomous incl. MCP tools (plans/01 §4.4) | MCP tool calls still require a client-side accept via `mcpServer/elicitation/request` (§8). `trusted=true` config does not bypass on 0.144.4 | AppServerClient must implement the auto-accept handler or every ui-tool call fails |
| D4 | `sandboxPolicy: workspaceWrite` at thread start scopes writes to the workspace (plans/01 §4.4) | Thread-level param is a bare mode string; the structured policy is turn-level; **/tmp + $TMPDIR writable by default** — must pass `excludeSlashTmp:true, excludeTmpdirEnvVar:true` | Concrete param placement + two extra flags |
| D5 | Skills listing "docs show `skillsList`" (plans/01 §4.6, plans/03 §2) | It's **`skills/list`** | Name fix only |
| D6 | Expected install dir "`.codex/skills` — verify" (plans/01 §4.6) | Confirmed `<workspace>/.codex/skills/<name>/SKILL.md`; but ancestor-dir discovery leaks repo-level skills into workspaces (§11) | Keep repo root clean of skill dirs |
| D7 | Reasoning preview via `item/reasoning/textDelta` or `summaryTextDelta` (plans/01 §4.3) | Nothing fires at gpt-5.6-sol default effort/summary. At `effort:"medium", summary:"detailed"`: `summaryTextDelta` (+`summaryPartAdded`) fire, but only when the model reasons long enough — not every turn. Raw `textDelta` never observed | Latency masking must lean on commentary-phase agentMessages (always stream early); reasoning summaries are a bonus stream, and turns should set `summary:"detailed"` to enable them |
| D8 | API-key headless auth "env var pickup?" open question (plans/08 §3) | Env var alone: **no** (401). `codex login --with-api-key` under target `CODEX_HOME`: **yes** (§10) | Deploy script must run the login step |
| D9 | Plans expect approval requests as `item/permissions/requestApproval` etc. possible under never-policy (plans/03 §2 "respond decline and log loudly") | None ever fired; the only server→client request is the MCP elicitation. Keep the decline-and-log handler as dead-man's insurance | None — design already right |
| D10 | `turn/completed` might carry token/usage info (plans/03 hypotheses) | It doesn't; usage streams via `thread/tokenUsage/updated` (cumulative + last) | Wire usage tracking to that notification |
| D11 | (addition) `turn/start` responds immediately with the turn id | — | TurnHandle can key event routing off the response; no need to wait for `turn/started` |
| D12 | (addition) agentMessages come in `phase:"commentary"` and `phase:"final_answer"` | — | Chat UI: stream both, style commentary as "thinking aloud"; commentary is our de-facto latency mask (D7) |

## 14. Spike checklist → evidence map

| Checklist item | Status | Evidence |
|---|---|---|
| 1 initialize handshake | PASS ×2 | fixtures 01 |
| 2 model/list + GPT-5.6 id | PASS ×2 | fixtures 02, §9 |
| 3 thread/start with cwd/sandbox/approvals/model | PASS ×2 | fixtures 03 |
| 4 cheap turn, full event stream | PASS ×2 | fixtures 04, §4 |
| 5 exec + file write in workspace; write outside denied | PASS ×2 | fixtures 05a/05b, §6 |
| 6 kill, respawn, thread/resume continuity | PASS ×2 | fixtures 06, §5 |
| 7 thread/fork sees prior context | PASS ×2 | fixtures 07, §5 |
| 8 MCP round-trip + registration mechanism | PASS ×2 | fixtures 08, §8 |
| 9 skills listing + install location | PASS ×2 | fixtures 09, §11 |
| 10 turn/interrupt mid-stream | PASS ×2 | fixtures 10, §4 |
| 11 headless API-key auth | PASS ×2 | fixtures 00/11, §10 |
| 12 whole script green twice, no stray processes | PASS | run logs; teardown step verifies PIDs |
