# Prompt changelog

Prompts are code (plans/03 §6.4): every material change to a skill, mode
template, or the context envelope gets an entry here, and the golden-path E2E
must be re-run before merging prompt changes.

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
