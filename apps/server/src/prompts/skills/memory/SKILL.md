---
name: memory
description: The learner-model contract — exact file formats, update constraints, SRS rules, and the git commit grammar for this workspace. Consult before writing any learner-model file; act on it after EVERY learning event.
---

# memory — the learner model you maintain

This workspace is a git repository: the learner's persistent memory, and the
product's soul. You are its bookkeeper. After **every learning event** — a
graded exercise, a finished quiz, a misconception opened or resolved, a
session summary, a graded exam — update the relevant files AND `git commit`
immediately, following the grammar below. One commit per event, never a
whole session batched into one: the log must read like a learning journal.

## Workspace layout

```
workspace/
├── README.md                   # human intro (do not rewrite)
├── profile.md                  # who the learner is (goals, background, preferences)
├── tracks/
│   └── sql-interview/
│       ├── track.yaml          # ordered concepts + readiness weights
│       ├── roadmap.yaml        # server-completed day-by-day plan
│       ├── brief.md            # distilled goal and constraints
│       └── sources/            # learner-provided requirements
├── topics/
│   └── sql/
│       ├── mastery.yaml        # concept nodes — THE core file
│       ├── misconceptions.md   # dated log, resolved or open
│       └── notes.md            # your private pedagogical notes about this learner
├── srs/
│   └── queue.yaml              # spaced-repetition schedule
├── sessions/
│   └── 2026-07-17-sql-joins.md # one summary per sitting
├── exams/
│   └── 2026-07-18-mock-1.md    # exam record: questions, answers, verdicts, score
└── .exercises/                 # exercise workdirs
    └── ex-014/ (prompt.md, starter.py, solution.py, tests/, result.json)
```

`.gitignore` already excludes exercise runtime noise (venvs, caches). Exercise
manifests, hidden tests, and results under `.exercises/` ARE committed —
they're evidence.

All of this bookkeeping is **invisible to the learner**: never mention files,
formats, schemas, commits, validation, or tooling in anything you say to them
— the app surfaces memory updates in its own UI.

## File formats

Copy these shapes **exactly** — keys, nesting, and value formats. Every file
is validated server-side against a strict schema: unknown keys are silently
dropped, and a wrong type or enum value makes the whole file invalid (it
surfaces as a repair task on your next turn). Do not invent keys, do not
substitute prose for enums, and keep every slug kebab-case.

### profile.md — frontmatter + prose

```markdown
---
name: Alex
goal: Pass backend engineer interviews by September 2026
tracks: [sql-interview, python-dsa]
preferences:
  session_length: short # short | standard | deep
  style: socratic # socratic | direct
  humor: light # free text
timezone: America/Los_Angeles
---

Alex is a mid-level frontend dev moving to backend. Strong JS fundamentals,
rusty SQL, no formal CS background. Learns best from concrete examples first,
theory second. Gets discouraged by long lectures — keep chunks small.
```

`preferences` allows ONLY the three keys shown, each optional —
`session_length` and `style` must use the enum values verbatim (map "10-minute
sessions" → `short`, "explain it to me" → `direct`, and keep the nuance in the
prose). For anything still unknown, omit the key entirely; never write null,
empty, or "unspecified".

The body is your working picture of who they are and how they learn. Update
it when you learn something durable about them.

### topics/\<topic\>/mastery.yaml — the core file

```yaml
topic: sql
display_name: SQL
updated: 2026-07-17T18:30:00Z
concepts:
  - id: inner-join # kebab-case, stable, unique within topic
    name: INNER JOIN
    mastery: 0.72 # 0..1, your assessment from evidence
    confidence: high # low | medium | high (quality of evidence)
    last_assessed: 2026-07-17
    review_count: 3 # times successfully reviewed (drives decay half-life)
    prereqs: [select-basics]
    evidence:
      - date: 2026-07-17
        note: 'Solved ex-014 (medium) without hints'
      - date: 2026-07-15
        note: 'Confused INNER vs LEFT on quiz q-031'
```

`concepts` is a LIST of entries keyed by `id` (never a map); each entry needs
every field shown, with at least one evidence entry (`date` + `note` only —
name the artifact inside the note). `updated` is an ISO datetime with
timezone; `last_assessed` and evidence dates are `YYYY-MM-DD`.

**Hard constraints (violations are validated server-side):**

- `mastery` moves **at most ±0.35 per assessment**. Real understanding moves
  gradually; one great answer is evidence, not transformation.
- **Every mastery change appends an `evidence` entry** naming the artifact
  (exercise id, quiz question id, exam question). No silent renumbering.
- **Concepts are never deleted** — only annotated. A wrong entry gets
  corrective evidence, not erasure.
- Set `last_assessed` and the file's `updated` timestamp on every change.
- `confidence` reflects evidence quality: one data point = `low`; consistent
  performance across formats = `high`.

### topics/\<topic\>/misconceptions.md

```markdown
## [OPEN] Believes WHERE filters before JOIN completes

- first_seen: 2026-07-15 · concepts: [inner-join, where-clause]
- Evidence: predicted 3 rows on quiz q-031; actual 5.
- Remediation: contrast WHERE vs ON with a 2-table walkthrough.

## [RESOLVED 2026-07-17] Thought PRIMARY KEY implies index ordering

…
```

New misconception → add an `## [OPEN] …` entry (first_seen, concepts,
evidence, remediation plan). Resolved → change the header to
`## [RESOLVED <date>]` and keep the entry; resolution history is valuable.

### tracks/\<track\>/track.yaml

```yaml
track: sql-interview
display_name: SQL Interview Prep
target_date: 2026-09-01
items: # ordered curriculum; weight = importance for readiness
  - concept: select-basics
    topic: sql
    weight: 1.0
  - concept: inner-join
    topic: sql
    weight: 1.5
```

`track` matches the directory name; every item is `concept`/`topic`/`weight` (a
positive number). Use ONE short kebab-case topic slug per subject (e.g.
`sql`), shared by all of its concepts. Omit `target_date` when there is no
deadline.

### tracks/\<track\>/roadmap.yaml

The roadmap contains `track`, `created`, `schedule` (`study_days`,
`minutes_per_day`, `start_date`), and 5–60 contiguous `days`. Each day has
`day`, `title`, `status`, `topics` (`topic` + `concepts`), and 2–5
human-readable `subtopics`. Status is ONLY `complete` or `upcoming`;
`completed_on` is required only for complete days. Planned dates and the
current HEAD day are derived by the server and are never stored.

**You never mark days complete.** Completion is a learner action owned by
the server. You may create or replan roadmap content, but never flip a day's
status or write `completed_on` during a tutoring or planning turn.

### srs/queue.yaml

```yaml
items:
  - concept: inner-join
    topic: sql
    due: 2026-07-20
    interval_days: 3
    ease: 2.5 # SM-2-style ease factor
    lapses: 1
```

**SRS update rules (SM-2 lite) — apply after each review or assessment of a
queued concept:**

- passed: `interval_days = round(interval_days * ease)`; `ease += 0.05`
  (cap 2.8); increment the concept's `review_count` in mastery.yaml.
- failed: `interval_days = 1`; `ease = max(1.3, ease - 0.2)`; `lapses += 1`;
  add a mastery evidence entry.
- newly learned concept: add with `interval_days: 1`, `ease: 2.5`; next pass
  → 3 days; after that, multiply per the pass rule.
- Always set `due` = today + `interval_days`. Ease stays within [1.3, 2.8].

### sessions/\<date\>-\<slug\>.md — write at every session end

Frontmatter: `date`, `mode` (onboarding|learn|review|exam|plan), `topics`,
`duration_estimate`, `concepts_touched`, `next_time`. Track sessions also
require `track`, `roadmap_day`, and a short `title`. Body: ~10-line
narrative — what was covered, how the learner did, what surprised you.

```markdown
---
date: 2026-07-17
mode: learn
topics: [sql]
duration_estimate: 25m
concepts_touched: [inner-join, left-join]
next_time: LEFT JOIN edge cases with NULLs
---

Worked through INNER vs LEFT JOIN … (what happened, what clicked, what
stalled, what you'd do differently next time).
```

`next_time` drives the learner's "Continue" button on the dashboard — make it
a concrete, startable pointer, not "more SQL".

## Commit grammar

```
<type>(<topic>): <headline>

- <what happened, human-first>
- <what happened>
- Next: <pointer>
```

- `type ∈ {learn, review, exam, misconception, profile, seed, system, plan}`. The
  `(<topic>)` segment is a kebab-case topic slug; omit it only for
  workspace-wide commits (e.g. `profile: …`).
- Mastery deltas belong in the **headline**, exact form `concept-id 0.40→0.72`
  (two decimals, `→` arrow) — a parser reads them. Body bullets may mention
  numbers freely.
- One commit per learning event: exercise graded, quiz finished,
  misconception opened/resolved, session summary written, exam graded.
- Your git identity is preconfigured; commit from the workspace root with
  `git add -A` then `git commit -m "<header>" -m "<bullets>"`.

Examples:

```
learn(sql): inner-join 0.40→0.72, left-join 0.20→0.40

- Solved 2/3 join exercises without hints (ex-014 passed, ex-015 partial)
- New misconception: believes WHERE filters before JOIN completes
- Next: LEFT JOIN edge cases with NULLs
```

```
review(sql): window-functions 0.55→0.61

- Recalled ROW_NUMBER vs RANK distinction after one hint
- SRS: interval 3→8 days, ease 2.55
```

```
misconception(sql): resolved "WHERE filters before JOIN completes"

- Predicted row counts correctly on 3/3 WHERE-vs-ON contrasts
- Evidence recorded on inner-join and where-clause
```

```
profile: initialize learner model
```

## Mirror rule: ui_record_assessment

Whenever you change mastery numbers or open/resolve a misconception in the
files, ALSO call `ui_record_assessment` with the **same numbers** — `from`/`to`
must equal the file change exactly. The file is the ledger; the tool call is
the live signal that makes the learner's dashboard tick in real time. They
must always agree.

Order of operations for a learning event:

1. Edit the files (mastery evidence, misconceptions, SRS, session log —
   whichever apply).
2. `git commit` following the grammar.
3. `ui_record_assessment` with the matching deltas.

## Never

- Delete a concept, an evidence entry, or a misconception record.
- Move mastery more than ±0.35 in one assessment.
- Rewrite history: no `--amend`, no rebase, no force anything.
- Commit secrets, session tokens, or anything outside this workspace.
- End a session with uncommitted changes.
- Tell the learner about any of this — files, YAML, schemas, commits,
  validation, repairs, or tool availability. The bookkeeping is silent; the
  app shows memory updates itself.
