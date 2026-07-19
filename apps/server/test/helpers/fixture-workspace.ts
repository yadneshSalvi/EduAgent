import fs from 'node:fs/promises';
import path from 'node:path';
import { GitService } from '../../src/workspace/GitService.js';

/**
 * The Phase 3 hand-authored fixture workspace (plans/06 Phase 3 task 6): one
 * SQL topic with four concepts at varied mastery/review_count, one track, an
 * SRS queue with 2 due-today + 1 overdue + 1 future item, an open
 * misconception, a session log with a "next time" pointer, and a 7-commit
 * backdated history that parses under the `02` §3 grammar.
 *
 * All dates are derived from `now` (days-ago offsets), so the SAME generator
 * seeds both the deterministic unit tests (pass FIXTURE_NOW) and the live E2E
 * (pass the real clock — the due items are then genuinely due today).
 *
 * The dashboard-service unit tests hand-compute expected numbers from the
 * literals below; if you change any value here, re-derive those.
 */

/** Unit-test clock: midday UTC so day-offset commits stay on their calendar days. */
export const FIXTURE_NOW = new Date('2026-07-16T12:00:00Z');

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

export interface FixtureRefs {
  /** ISO date `daysAgo` days before `now` (UTC calendar). */
  iso: (daysAgo: number) => string;
  /** The 7 commit shas, oldest first. */
  shas: string[];
}

export async function seedFixtureWorkspace(dir: string, now: Date): Promise<FixtureRefs> {
  const iso = (daysAgo: number): string =>
    new Date(now.getTime() - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
  /** Commit instant strictly before `now`: n days and h hours ago. */
  const at = (daysAgo: number, hoursAgo: number): Date =>
    new Date(now.getTime() - daysAgo * MS_PER_DAY - hoursAgo * MS_PER_HOUR);

  await fs.mkdir(dir, { recursive: true });
  const git = new GitService(dir);
  await git.init();
  const shas: string[] = [];

  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };
  const commit = async (message: string, backdate: Date): Promise<void> => {
    shas.push(await git.commitAll(message, { backdate }));
  };

  const mastery = (concepts: string[]): string =>
    [
      'topic: sql',
      'display_name: SQL',
      `updated: ${now.toISOString()}`,
      concepts.length === 0 ? 'concepts: []' : 'concepts:',
      ...concepts,
    ].join('\n') + '\n';

  const selectBasics = [
    '  - id: select-basics',
    '    name: SELECT basics',
    '    mastery: 0.80',
    '    confidence: high',
    `    last_assessed: ${iso(14)}`,
    '    review_count: 3',
    '    prereqs: []',
    '    evidence:',
    `      - date: ${iso(14)}`,
    "        note: 'Reviewed projections and aliases without hints'",
  ];
  const whereClause = [
    '  - id: where-clause',
    '    name: WHERE clause',
    '    mastery: 0.55',
    '    confidence: medium',
    `    last_assessed: ${iso(10)}`,
    '    review_count: 2',
    '    prereqs: [select-basics]',
    '    evidence:',
    `      - date: ${iso(10)}`,
    "        note: 'Filtered correctly on 3/4 quiz questions'",
  ];
  const innerJoin = [
    '  - id: inner-join',
    '    name: INNER JOIN',
    '    mastery: 0.72',
    '    confidence: medium',
    `    last_assessed: ${iso(2)}`,
    '    review_count: 1',
    '    prereqs: [select-basics, where-clause]',
    '    evidence:',
    `      - date: ${iso(2)}`,
    "        note: 'Solved ex-014 (medium) without hints'",
  ];
  const leftJoin = [
    '  - id: left-join',
    '    name: LEFT JOIN',
    '    mastery: 0.40',
    '    confidence: low',
    `    last_assessed: ${iso(1)}`,
    '    review_count: 0',
    '    prereqs: [inner-join]',
    '    evidence:',
    `      - date: ${iso(1)}`,
    "        note: 'First pass: NULL handling still shaky'",
  ];

  const srs = (items: string[]): string =>
    (items.length === 0 ? 'items: []' : ['items:', ...items].join('\n')) + '\n';
  const srsItem = (concept: string, due: string, interval: number, ease: number, lapses: number) =>
    [
      `  - concept: ${concept}`,
      '    topic: sql',
      `    due: ${due}`,
      `    interval_days: ${interval}`,
      `    ease: ${ease}`,
      `    lapses: ${lapses}`,
    ].join('\n');

  // -- commit 1: workspace born ---------------------------------------------
  await write('README.md', '# Your memory\n\nThis repo is your learning memory.\n');
  await write(
    'profile.md',
    [
      '---',
      'name: Casey',
      'goal: Pass a SQL screen by the end of the summer',
      'tracks: [sql-interview]',
      'preferences:',
      '  session_length: short',
      '  style: socratic',
      'timezone: UTC',
      '---',
      '',
      'Casey is a data analyst moving into backend work. Confident with',
      'spreadsheets, rusty on SQL joins. Short focused sessions land best.',
    ].join('\n') + '\n',
  );
  await write(
    'tracks/sql-interview/track.yaml',
    [
      'track: sql-interview',
      'display_name: SQL Interview Prep',
      `target_date: ${iso(-45)}`,
      'items:',
      '  - concept: select-basics',
      '    topic: sql',
      '    weight: 1.0',
      '  - concept: inner-join',
      '    topic: sql',
      '    weight: 1.5',
      '  - concept: left-join',
      '    topic: sql',
      '    weight: 1.2',
      '  - concept: where-clause',
      '    topic: sql',
      '    weight: 1.0',
      '  - concept: window-functions',
      '    topic: sql',
      '    weight: 1.3',
    ].join('\n') + '\n',
  );
  await write('topics/sql/mastery.yaml', mastery([]));
  await write('srs/queue.yaml', srs([]));
  await commit('profile: initialize learner model', at(15, 3));

  // -- commit 2: select-basics assessed -------------------------------------
  await write('topics/sql/mastery.yaml', mastery(selectBasics));
  await write('srs/queue.yaml', srs([srsItem('select-basics', iso(2), 14, 2.6, 0)]));
  await commit(
    [
      `learn(sql): select-basics 0.55→0.80`,
      '',
      '- Nailed projections, aliases, and DISTINCT on first pass',
      '- Next: WHERE clause fundamentals',
    ].join('\n'),
    at(14, 2),
  );

  // -- commit 3: where-clause assessed --------------------------------------
  await write('topics/sql/mastery.yaml', mastery([...selectBasics, ...whereClause]));
  await write(
    'srs/queue.yaml',
    srs([
      srsItem('select-basics', iso(2), 14, 2.6, 0),
      srsItem('where-clause', iso(0), 10, 2.5, 1),
    ]),
  );
  await commit(
    [
      `learn(sql): where-clause 0.30→0.55`,
      '',
      '- Comparison and BETWEEN predicates solid; NULL comparisons shaky',
    ].join('\n'),
    at(10, 1),
  );

  // -- commit 4: misconception opened ---------------------------------------
  await write(
    'topics/sql/misconceptions.md',
    [
      '## [OPEN] Believes WHERE filters before JOIN completes',
      `- first_seen: ${iso(8)} · concepts: [inner-join, where-clause]`,
      '- Evidence: predicted 3 rows on quiz q-031; actual 5.',
      '- Remediation: contrast WHERE vs ON with a 2-table walkthrough.',
    ].join('\n') + '\n',
  );
  await commit(
    [
      'misconception(sql): believes WHERE filters before JOIN completes',
      '',
      '- Predicted 3 rows on quiz q-031; actual 5',
    ].join('\n'),
    at(8, 2),
  );

  // -- commit 5: inner-join assessed ----------------------------------------
  await write('topics/sql/mastery.yaml', mastery([...selectBasics, ...whereClause, ...innerJoin]));
  await write(
    'srs/queue.yaml',
    srs([
      srsItem('select-basics', iso(2), 14, 2.6, 0),
      srsItem('where-clause', iso(0), 10, 2.5, 1),
      srsItem('inner-join', iso(0), 3, 2.5, 0),
    ]),
  );
  await commit(
    [
      `learn(sql): inner-join 0.50→0.72`,
      '',
      '- Solved ex-014 (medium) without hints',
      '- Watch the WHERE-vs-ON misconception here',
    ].join('\n'),
    at(2, 3),
  );

  // -- commit 6: left-join assessed + session log ----------------------------
  await write(
    'topics/sql/mastery.yaml',
    mastery([...selectBasics, ...whereClause, ...innerJoin, ...leftJoin]),
  );
  await write(
    'srs/queue.yaml',
    srs([
      srsItem('select-basics', iso(2), 14, 2.6, 0),
      srsItem('where-clause', iso(0), 10, 2.5, 1),
      srsItem('inner-join', iso(0), 3, 2.5, 0),
      srsItem('left-join', iso(-4), 5, 2.5, 0),
    ]),
  );
  await write(
    `sessions/${iso(1)}-sql-joins.md`,
    [
      '---',
      `date: ${iso(1)}`,
      'mode: learn',
      'topics: [sql]',
      'duration_estimate: 25m',
      'concepts_touched: [inner-join, left-join]',
      'next_time: LEFT JOIN edge cases with NULLs',
      '---',
      '',
      'Worked INNER vs LEFT JOIN on the orders/customers pair. INNER JOIN is',
      'clicking; LEFT JOIN NULL handling needs another pass next time.',
    ].join('\n') + '\n',
  );
  await commit(
    [
      `learn(sql): left-join 0.20→0.40`,
      '',
      '- First LEFT JOIN pass; NULL extension rows still surprise',
      '- Next: LEFT JOIN edge cases with NULLs',
    ].join('\n'),
    at(1, 4),
  );

  // -- commit 7: this morning's quick review (no headline deltas) ------------
  await write(
    'topics/sql/notes.md',
    'Quick recall check this morning: join direction articulated correctly.\n',
  );
  await commit(
    [
      'review(sql): quick recall check on joins',
      '',
      '- Verbal recall of INNER vs LEFT semantics, no quiz',
    ].join('\n'),
    at(0, 4),
  );

  return { iso, shas };
}
