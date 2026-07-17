# Prompt changelog

Prompts are code (plans/03 §6.4): every material change to a skill, mode
template, or the context envelope gets an entry here, and the golden-path E2E
must be re-run before merging prompt changes.

## 2026-07-17 — Phase 2A: tool descriptions + grading-turn templates

- Added `uiToolDescriptions` (packages/shared/src/mcp-tools.ts) — the
  model-facing MCP tool descriptions. Written as guardrails: they restate the
  teach-skill preconditions (hidden tests BEFORE ui_push_exercise, run tests
  before ui_grade_exercise, file-first for ui_record_assessment).
- New server-initiated turn templates (system role, never rendered as the
  learner): `buildExerciseGradingTurn` (api/exercises.ts — run hidden tests in
  the sandbox, never infer verdicts, ui_grade_exercise then memory-skill
  commit + ui_record_assessment mirror; submission inlined ≤8KB) and
  `buildQuizGradingTurn` (api/quiz.ts — answers + instant-checked verdicts as
  evidence, ui_grade_quiz for short answers, brief chat recap, commit+mirror).
- UiToolRelay result/error strings (relay/index.ts) are themselves prompt
  surface: success strings restate the next guardrail ("wait for the
  submission; do not reveal the hidden tests or the solution"), errors are
  written for in-turn self-correction ("re-read the session_token from your
  instructions", "write meaningful tests … THEN call ui_push_exercise again").
- No teach/memory skill edits were needed: Phase 2 E2E runs showed compliance
  with the existing exercise/grading directives.

## 2026-07-17 — Phase 1 QA fixes (findings M1/M2/M3, p9c)

- **Root cause first (not a prompt):** the teach/memory skills at
  `$DATA_DIR/.codex/skills` were invisible to the model — codex 0.144.4 does
  NOT ancestor-walk skill discovery from thread cwds (PROTOCOL_NOTES Phase 1
  addenda). AppServerClient now registers the root via `skills/extraRoots/set`
  after every (re)spawn, and boot fails unless `skills/list` shows both
  skills. Every prompt change below assumes the skills are now actually read.
- Added `prompts/voice.ts` (`LEARNER_VOICE_RULES`), included in BOTH mode
  templates and (as prose) the teach skill §0 + memory skill (M3): memory
  bookkeeping is silent — never mention files, YAML, schemas, git, commits,
  validation, repairs, tools, or skills (nor their availability) to the
  learner; commentary describes learning content, not infrastructure.
- `buildLearnInstructions` greeting protocol rewritten (M1): first message of
  a sitting opens with a 1–2 line personal recall (goal + last-session
  pointer, or the first lesson from their track when no session log exists);
  never re-ask what the learner model answers, never announce calibration.
- State digest (M1): profile-present-but-no-session-log now emits "No session
  log yet: onboarding is done, this sitting is their first real lesson";
  unrecoverable profile.md emits a repair line instead of the false "has not
  completed onboarding".
- `buildOnboardingInstructions` (M2, p9c, M3): interview capped at 4 questions
  (matches the wizard's 4 step chips); exact copy-pasteable YAML templates for
  profile.md / tracks / mastery / srs now ride inline (exported as
  `ONBOARDING_FILE_TEMPLATES`; unit test zod-validates them against the shared
  schemas); the baseline-quiz fallback is explicitly silent. New
  `ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET` (1700) documents the deliberate
  budget exception; lean mode budget is now 800.
- Memory skill: "copy these shapes exactly" preamble (unknown keys dropped,
  enums strict), per-file shape callouts (concepts is a LIST; preference
  enums; ISO timestamp formats), silent-bookkeeping "Never" bullet.
- Workspace README template: format guide now names the exact keys/enums per
  file (QA showed the model falls back to the README when lost — the one file
  whose exact keys it carried, srs/queue.yaml, was the one file onboarding
  got right).
- E2E additions: needsRepair === [] immediately after onboarding (M2), recall
  + no-calibration assertions on the learn greeting (M1), transcript voice
  scan — report-only broad pattern, hard-fail on plumbing-narration offender
  classes (M3).

## 2026-07-17 — initial prompt layer (Phase 1B)

- Authored `teach` skill (`apps/server/src/prompts/skills/teach/SKILL.md`):
  calibrate-first (zone of proximal development), ≤150-word chunks then
  learner acts, Socratic default → direct after two stalls, history
  references once-or-twice per session, exercise author/grade flows with
  hidden tests, feedback rubric without solution reveal, session-end protocol.
- Authored `memory` skill (`apps/server/src/prompts/skills/memory/SKILL.md`):
  plans/02 §1–3 formats embedded (layout, YAML schemas, examples), hard
  constraints (±0.35 max delta, evidence required, never delete), SM-2-lite
  SRS rules, commit grammar with parseable examples, ui_record_assessment
  mirror rule, "commit after every learning event".
- Added mode templates: `buildLearnInstructions` (greeting protocol on
  session start) and `buildOnboardingInstructions` (interview → profile.md +
  track + low-confidence baseline → `profile: initialize learner model`),
  plus `buildContextEnvelope` (labeled digest prefix + needs-repair
  directive). Budget tests: digest ≤ 600 tokens, mode instructions ≤ 700.
