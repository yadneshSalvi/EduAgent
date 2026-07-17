/**
 * The files a fresh workspace is born with (plans/02 §1). Deliberately no
 * profile.md — its existence (committed) is the "onboarded" signal
 * (plans/03 §7 GET /auth/me), so onboarding must be the one to write it.
 */

const README = `# Your Memory

This repository is your memory — a learner model maintained for you by
EduAgent, your AI tutor. After every learning event (a graded exercise, a
finished quiz, a resolved misconception, a session summary) the tutor updates
these files and commits the change with a human-readable message. That gives
you three guarantees no human tutor can offer:

- **Inspectable** — everything the tutor believes about you is plain
  markdown/YAML in this repo. Read it.
- **Auditable** — \`git log\` is your learning journal. Diff any two moments of
  your own understanding.
- **Portable** — these are your files. Take them to any tool that can read
  text.

## Layout

\`\`\`
workspace/
├── README.md                   # this file
├── profile.md                  # who you are: goals, background, preferences
├── tracks/
│   └── <track>.yaml            # goal-oriented curriculum: ordered concepts + weights
├── topics/
│   └── <topic>/
│       ├── mastery.yaml        # concept nodes with 0–1 mastery scores — THE core file
│       ├── misconceptions.md   # dated log of misconceptions, open or resolved
│       └── notes.md            # the tutor's pedagogical notes about you
├── srs/
│   └── queue.yaml              # spaced-repetition schedule (what's due when)
├── sessions/
│   └── <date>-<slug>.md        # one summary per sitting, with a "next time" pointer
├── exams/
│   └── <date>-<slug>.md        # exam records: questions, answers, verdicts, score
└── .exercises/                 # exercise workdirs (runtime noise gitignored;
                                #   manifests, tests and results are committed)
\`\`\`

## Format guide

- \`profile.md\` — YAML frontmatter (\`name\`, \`goal\`, \`tracks\`,
  \`preferences\` with only \`session_length\`: short|standard|deep,
  \`style\`: socratic|direct, \`humor\`; \`timezone\`) followed by free prose
  about how you learn best.
- \`topics/<topic>/mastery.yaml\` — \`topic\`, \`display_name\`, \`updated\`
  (ISO datetime), and \`concepts\`: a list of entries with \`id\`, \`name\`,
  \`mastery\` (0–1), \`confidence\` (low|medium|high), \`last_assessed\`,
  \`review_count\`, \`prereqs\`, and an \`evidence\` list (\`date\` + \`note\`)
  justifying every score change. Concepts are never deleted, only annotated.
- \`topics/<topic>/misconceptions.md\` — \`## [OPEN] …\` / \`## [RESOLVED <date>] …\`
  entries with evidence and a remediation plan.
- \`tracks/<track>.yaml\` — \`track\`, \`display_name\`, optional
  \`target_date\`, and \`items\`: the ordered curriculum (\`concept\`,
  \`topic\`, \`weight\`) whose weights drive your readiness score.
- \`srs/queue.yaml\` — \`items\` of SM-2-style spaced repetition: \`concept\`,
  \`topic\`, \`due\`, \`interval_days\`, \`ease\`, \`lapses\`.
- \`sessions/<date>-<slug>.md\` — frontmatter (\`date\`, \`mode\`, \`topics\`,
  \`duration_estimate\`, \`concepts_touched\`, \`next_time\`) + a short
  narrative of the sitting.

Commit messages follow \`<type>(<topic>): <headline>\` where type is one of
learn, review, exam, misconception, profile, seed, system — mastery changes
appear in the headline as \`concept-id 0.40→0.72\`.

You can edit these files yourself, but the tutor is the bookkeeper: if you
change something, tell the tutor so it can re-assess honestly.
`;

const GITIGNORE = `# Exercise workdirs: manifests, hidden tests and results ARE committed (they're
# evidence) — runtime noise is not (plans/02 §1).
.exercises/*/venv/
.exercises/*/.venv/
.exercises/*/node_modules/
.exercises/*/__pycache__/
__pycache__/
*.pyc
.pytest_cache/
.DS_Store
`;

const SRS_QUEUE = `# Spaced-repetition queue — format guide in README.md.
items: []
`;

/** Workspace-relative path → initial content. Empty dirs are kept via .gitkeep. */
export const WORKSPACE_TEMPLATE: ReadonlyArray<{ path: string; content: string }> = [
  { path: 'README.md', content: README },
  { path: '.gitignore', content: GITIGNORE },
  { path: 'srs/queue.yaml', content: SRS_QUEUE },
  { path: 'tracks/.gitkeep', content: '' },
  { path: 'topics/.gitkeep', content: '' },
  { path: 'sessions/.gitkeep', content: '' },
  { path: 'exams/.gitkeep', content: '' },
  { path: '.exercises/.gitkeep', content: '' },
];

/** Initial commit message — parses as type "system", topic null (plans/03 §3.2). */
export const WORKSPACE_INIT_COMMIT = 'system: initialize memory';
