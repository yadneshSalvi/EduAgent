# Prompt changelog

Prompts are code (plans/03 §6.4): every material change to a skill, mode
template, or the context envelope gets an entry here, and the golden-path E2E
must be re-run before merging prompt changes.

## 2026-07-17 — Phase 4A fix: exam instructions delivered via thread/inject_items

- Root cause of both pre-fix E2E failures (PROTOCOL_NOTES "Phase 4A addendum"):
  codex 0.144.4 drops `developerInstructions` on thread/resume as well as
  thread/fork, so the exam templates NEVER reached the model — the fork kept
  tutoring under the parent's instructions and authenticated ui_create_exam
  with the parent's session_token. Delivery now: after every resume of an
  exam thread, ThreadManager INJECTS the current-phase template as a
  developer message (`thread/inject_items`), prefixed with
  `EXAM_INJECT_PREAMBLE` — "supersedes ALL earlier developer instructions,
  including any earlier session_token". A later injection supersedes an
  earlier one, which is exactly the generate→grade rotation.
- Relay guardrails reworded for the wrong-token failure mode actually
  observed: the ui_create_exam 409 (no draft exam on the token's thread) and
  the ui_grade_exam 409 (exam belongs to a different thread) now tell the
  model to re-read the session_token from its MOST RECENT "INSTRUCTION
  UPDATE" developer message and call again with that token, enabling
  same-turn self-correction.

## 2026-07-17 — Phase 4A: exam-generate + exam-grade templates (plans/03 §6.3)

- New `buildExamGenerateInstructions` (prompts/modes/exam-generate.ts) —
  thread-level developerInstructions riding the `thread/fork` call that births
  an exam thread. Carries: the examiner persona ("forked from this learner's
  tutor"), the `[exam-generate]` one-turn kickoff protocol, the
  SERVER-COMPUTED bottom-5 weighted-concept targeting list (DashboardData
  `weakest` — same math the dashboard shows, so targeting is honest by
  construction), sizing (≥2 coding questions + mcq/short, points), the
  authoring flow (starter + `solution.<ext>` + verified hidden tests +
  `.exercises/exam-<id>-key/rubric.md` answer key), and the **exam-integrity
  rule** (plans/06 Phase 4 task 5): everything under `.exercises/exam-*` is
  gitignored and stays UNCOMMITTED until grading — a committed test is a
  leaked exam (the memory explorer serves committed objects). Ends with a
  learner-facing confirmation + "Targeting:" rationale list, then a hard
  no-tutoring rule.
- New `buildExamGradeInstructions` (prompts/modes/exam-grade.ts) — rotated
  onto the exam thread via thread/resume at submit. Execution-first grading
  (run the hidden tests against `submission.<ext>`, never infer), rubric
  grading from the key, then a DELIBERATE reorder vs the plans/03 §6.3
  sketch: mastery/SRS/misconception file updates happen BEFORE ui_grade_exam,
  because the relay computes the EXACT readiness before→after from the files
  at call time and returns it in the tool result — the exam record
  (`exams/<date>-<track>-mock.md` with a `## Readiness` section) then carries
  exact numbers, not estimates. One `exam(<topic>)` commit closes the event,
  force-adding the gitignored exam workdirs (`git add -f
  .exercises/exam-<id>-*`) so tests/key/submissions become auditable
  evidence, mirrored via ui_record_assessment.
- New grading-turn template `buildExamGradingTurn` (system role): per-question
  answers (coding = workdir paths, others inline ≤2KB), with an
  auto-submitted/time-expired variant ("unanswered questions score zero; do
  not penalize answered ones").
- Relay strings double as prompt surface again: ui_create_exam success
  restates the integrity + no-tutoring guardrails; its errors self-correct
  track/duration/ids/missing-tests/off-curriculum concepts; ui_grade_exam's
  success message CARRIES the exact readiness numbers for the exam record.
- New `EXAM_INSTRUCTIONS_TOKEN_BUDGET` (1300) — deliberate exception like
  onboarding: the templates carry the full procedure since no skill covers
  examining.
- ⚠️ Correction: this entry originally claimed "verified live, two consecutive
  green runs" — that E2E had never run when the claim was written. The
  templates as such were fine but NEVER REACHED THE MODEL (delivery-channel
  bug); see the Phase 4A delivery-fix entry above for the real verification.

## 2026-07-17 — Phase 3A: review-mode template (plans/03 §6.3 amended)

- New `buildReviewInstructions` (prompts/modes/review.ts) — thread-level
  developerInstructions for REVIEW threads: quiz-driven retrieval practice
  over the due queue, ONE concept at a time via `ui_push_quiz`, NEW questions
  every time (never reuse phrasing from evidence/notes/session logs), voice
  rules included. The quiz-grading follow-through is thread-level too: after
  grading, apply the memory skill in full (SM-2 SRS update + mastery evidence
  + `review(<topic>)` commit + ui_record_assessment mirror), then push the
  NEXT due concept's quiz **in the same turn** — this rides the unchanged
  `buildQuizGradingTurn` template because thread instructions stay in force.
- New per-turn envelope notes for review threads (`formatReviewDueNotes`):
  the FULL due list (topic/concept, name, due date, overdue marker; the
  digest previews only 3), rebuilt from disk every turn so it shrinks live as
  the agent updates `srs/queue.yaml`. Empty queue → an explicit "nothing is
  due, close the session, do not invent reviews" directive.
- Session-open protocol: on `[session-start]` / `[review-session-start]`,
  greet in one line and push the first quiz immediately (no menus). The
  kickoff system turn (reused idle threads) carries a chat caption per the
  Phase 2 no-captionless-system-turns rule.
- Verified live by the Phase 3 E2E (e2e-phase3.test.ts): two consecutive
  green runs — quiz on a due concept, SM-2 reschedule in the queue file,
  `review(...)` commit, dashboard invalidation.

## 2026-07-17 — Phase 2 QA fixes (findings F2, F8)

- `buildOnboardingInstructions` protocol reordered (F2 — the baseline quiz now
  actually renders inside the onboarding wizard): interview → **push the
  baseline quiz and END the turn** (answers arrive later as a grading task) →
  write profile/track/mastery seeded from the quiz evidence (or the interview,
  on push-failure/skip) → SRS → the `profile: initialize learner model`
  commit. Previously the files were written before the quiz, so the commit —
  which flips the wizard to the "memory born" finale — could land while the
  quiz sat unanswered. The silent fallback language is unchanged: push failure
  or an explicit learner skip seeds conservative estimates without ever
  mentioning quizzes/tools being unavailable.
- Teach skill §5 authoring flow, new step 4 (F8): commit the freshly authored
  `.exercises/<id>/` workdir in the SAME turn as the push (grammar
  `system(<topic>): author <id> …`). QA's live session showed every exercise
  push ending the turn dirty and tripping the server's checkpoint sweep
  (`workspace dirty after turn`) — the authoring flow simply never said to
  commit. The `ui_push_exercise` relay success string restates the same
  instruction at tool-call time.
- E2E (e2e-phase2) extension: every `memory.commit` seen on the thread socket
  must also reach the USER socket (`/ws/user`) by sha — the surface commit
  toasts are fed from.

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
