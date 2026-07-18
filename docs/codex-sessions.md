# Codex Sessions Log

> **Submission requirement** (openai.devpost.com/rules): the Devpost entry needs a README section
> explaining our collaboration with Codex AND **a Codex Session ID demonstrating core functionality**.

EduAgent is in an unusual position for this requirement: **the product's runtime *is* Codex**
(`codex app-server` spawned by our agent host). Every tutoring session, every sandboxed grading
run, every memory commit, and every exam fork is a real Codex session with a rollout on disk.
The sessions below were harvested from those rollouts (`rollout-<timestamp>-<session-id>.jsonl`),
which are the ground truth: each one records the session id, the thread's cwd (the learner's
memory workspace), every developer/user message, every sandboxed command, and every MCP `ui_*`
tool call the agent made against our UI.

Rollout stores on the dev machine:

| Store | What lands there |
|---|---|
| `~/.codex/sessions/` | Sessions from the locally-run product (`pnpm dev` inherits the user's `CODEX_HOME`) — 24 EduAgent runtime rollouts (cwd inside `data/workspaces/…`), plus the team's own Codex CLI dev sessions |
| `data/spike-workspace/codex-home/sessions/` | The isolated `CODEX_HOME` used by the protocol spike and the live E2E suites — 73 rollouts |

## ⭐ Devpost pick — "Session ID demonstrating core functionality"

**Primary: `019f7404-6ec1-7240-b1d7-045c9caad451`** (2026-07-18, cwd `data/workspaces/alex`).
The full-dress rehearsal of the demo lesson, run through the real product: across 5 turns the
tutor greets Alex by recalling the September interview goal and the "LEFT JOIN edge cases with
NULLs" pointer from the last session log, pushes a SQL exercise into the workbench
(`ui_push_exercise`), grades both submissions — the wrong first attempt, then the corrected
one — by executing them in the Codex sandbox (`ui_grade_exercise` ×2), records three mastery
assessments (`ui_record_assessment`), resolves the seeded `[OPEN]` misconception (the
`misconception(sql): resolved …` commit is in the transcript), and commits each learning event
to Alex's memory repo.

**Companion: `019f7414-72db-7833-8ef5-6e0478833761`** — the exam session **forked from the
session above** (`forked_from_id: 019f7404-…` in its rollout meta). Because a fork copies the
parent transcript, this single rollout contains the whole story: the inherited tutor context,
the injected examiner instructions (`thread/inject_items` generate→grade rotation), exam
generation (`ui_create_exam`), and sandbox-executed grading (`ui_grade_exam`) with the readiness
delta committed back to memory. If only one id fits the form, the primary is the tutor loop;
paste the companion into the README/testing notes as the fork proof.

## Product runtime sessions (`~/.codex/sessions/2026/07/…`, cwd `data/workspaces/…`)

These are sessions where Codex ran **as EduAgent** — the agent host spawned `codex app-server`,
and each learner thread became a Codex thread whose cwd is that learner's git-versioned memory.

| Session ID | Date (UTC) | What it demonstrates |
|---|---|---|
| `019f7404-6ec1-7240-b1d7-045c9caad451` | 2026-07-18 | ⭐ **Demo-lesson dry run on seeded Alex** — recall greeting, exercise push, sandbox grading, misconception resolution, memory commits |
| `019f7414-72db-7833-8ef5-6e0478833761` | 2026-07-18 | ⭐ **Exam fork of the session above** — `thread/fork`, injected examiner rotation, `ui_create_exam`, sandboxed `ui_grade_exam` |
| `019f73d1-4540-70d1-b35a-92cdde39acd1` | 2026-07-18 | Review-mode dry run — the day's 3 due concepts quizzed with freshly generated questions (`ui_push_quiz` ×3), graded, SRS updates committed |
| `019f6ec4-06d2-7ee3-8d7f-efc1189e070f` | 2026-07-17 | 10-turn workbench loop on a fresh learner — 2 exercises pushed, 3 sandbox gradings, a quiz, a generated artifact, 4 mastery assessments |
| `019f711e-a73e-7b11-9185-7e0727307ff5` | 2026-07-17 | 10-turn soak session — quiz + exercise flow with 8 mastery assessments and 10 memory-committing sandbox runs |
| `019f6e12-ba2a-7da3-8588-f427c13c7a4f` | 2026-07-17 | 9-turn interactive session — exercise pushed and graded in the sandbox, 7 memory-committing runs |

Remaining runtime rollouts in this store are additional interactive passes on 2026-07-17/18 —
onboarding starts on the empty profile Sam, earlier full-loop passes on Alex, review warm-ups —
across seeded and fresh learners.

## Live E2E acceptance runs (isolated `CODEX_HOME`: `data/spike-workspace/codex-home/sessions/`)

Each phase's golden-path E2E (`apps/server/test/e2e-phase*.test.ts`, gated behind
`RUN_CODEX_E2E=1`) boots the **real production graph** — real codex child process, real MCP
registration, real workspaces — and drives it over HTTP + WS only. 51 E2E rollouts total;
representative final-green runs:

| Session ID | Date (UTC) | Suite / what ran |
|---|---|---|
| `019f6e50-64bb-74a3-8f8c-f6f447077f11` | 2026-07-17 | Phase 1 E2E — local-login → onboarding greeting streams → memory commit → dashboard reflects it |
| `019f7403-2c4c-7621-ae1c-4ea8015df5ca` | 2026-07-18 | Phase 2 E2E — 7-turn workbench proof: exercise pushed, submission executed + graded in sandbox, quiz, artifact, assessments committed |
| `019f7128-33a3-77a3-9227-38c40cc4a77b` | 2026-07-17 | Phase 3 E2E — 3 due SRS items → fresh-generated review questions → mastery/SRS updates committed |
| `019f7129-7fa6-78b3-8eb8-83415b41c0fa` | 2026-07-17 | Phase 4 E2E — exam generation on a `thread/fork` of the tutor thread (injected examiner instructions) |
| `019f712c-151c-7600-99c1-5a07f9b11b8c` | 2026-07-17 | Phase 4 E2E — exam grading turn on the fork: answers executed against tests, readiness delta committed |

## Protocol spike sessions (same isolated store)

`scripts/spike-appserver.mjs` — the Phase 0 spike that pinned every wire fact in
`docs/PROTOCOL_NOTES.md` (14 steps, green twice in a row; originator `eduagent-spike`;
12 rollouts across 6 runs on 2026-07-16). First and final-green pair:

| Session ID | Date (UTC) | What ran |
|---|---|---|
| `019f6ce4-4779-7052-9ceb-e55466e87fd2` | 2026-07-16 | First spike run — handshake, turns, sandbox-denial probe, resume-after-SIGKILL |
| `019f6d0f-dd48-7002-854d-a9d4cb447c94` | 2026-07-16 | Final green run A — full 14-step checklist |
| `019f6d10-34a5-7343-8d1c-50449147cffe` | 2026-07-16 | Final green run B — fork inheritance, MCP round-trip, interrupt, skills listing |

Plus 2 `eduagent-probe` rollouts (2026-07-17) — the live disproof/proof harness for the
`thread/inject_items` developer-instruction channel documented in PROTOCOL_NOTES §Phase 4A.

## How to inspect a rollout

```sh
# find a rollout by session id
find ~/.codex/sessions data/spike-workspace/codex-home/sessions -name '*<session-id>*'
# first line = session meta (id, cwd, fork parentage); rest = full transcript
head -1 <rollout>.jsonl | python3 -m json.tool | head -30
grep -o 'eduagent-ui__ui_[a-z_]*' <rollout>.jsonl | sort | uniq -c   # MCP ui_* calls
```

## Dev-tooling sessions (built *with* Codex)

The team also used the Codex CLI as a development tool while building EduAgent (separate from
the runtime sessions above, same `~/.codex/sessions/` store). Team members: add your strongest
dev sessions here with a one-line description before submission.

| Session ID | Date | Engineer | What was built / done |
|---|---|---|---|
| _(add)_ | | | |
