import { load as yamlLoad } from 'js-yaml';
import {
  masteryFileSchema,
  profileFrontmatterSchema,
  roadmapFileSchema,
  srsQueueFileSchema,
  trackFileSchema,
  trackBriefFrontmatterSchema,
} from '@eduagent/shared';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_FILE_TEMPLATES } from '../src/prompts/modes/onboarding.js';
import { PLAN_FILE_TEMPLATES } from '../src/prompts/modes/plan.js';
import {
  buildContextEnvelope,
  buildLearnInstructions,
  buildOnboardingInstructions,
  buildPlanInstructions,
  buildReviewInstructions,
  estimateTokens,
  formatReviewDueNotes,
  MODE_INSTRUCTIONS_TOKEN_BUDGET,
  ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET,
  PLAN_INSTRUCTIONS_TOKEN_BUDGET,
  readSkillSource,
  REVIEW_KICKOFF_INPUT,
  SKILL_NAMES,
} from '../src/prompts/index.js';
import { parseCommit } from '../src/workspace/index.js';
import type { LearnerModel } from '../src/workspace/index.js';

const TOKEN = 'tok_sentinel_12345';

describe('mode templates (plans/03 §6.3–6.4)', () => {
  it('learn instructions carry the session token, mode, and both skill names', () => {
    const text = buildLearnInstructions({
      sessionToken: TOKEN,
      topicSlug: 'sql',
      topicDisplayName: 'SQL',
      isSessionStart: true,
    });
    expect(text).toContain(TOKEN);
    expect(text).toContain('Mode: LEARN');
    expect(text).toContain('SQL');
    expect(text).toContain('`teach` skill');
    expect(text).toContain('`memory` skill');
    expect(text).toContain('ui_record_assessment');
    expect(text).toContain('Never reveal this token');
    expect(estimateTokens(text)).toBeLessThanOrEqual(MODE_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('learn instructions include the greeting protocol only at session start', () => {
    const base = { sessionToken: TOKEN, topicSlug: 'sql' };
    const atStart = buildLearnInstructions({ ...base, isSessionStart: true });
    expect(atStart).toContain('First message of this sitting');
    // QA finding M1: recall, never a re-interview.
    expect(atStart).toContain('PERSONAL recall');
    expect(atStart).toContain('Never re-ask');
    expect(buildLearnInstructions({ ...base, isSessionStart: false })).not.toContain(
      'First message of this sitting',
    );
  });

  it('mode instructions carry the learner-facing voice rules (QA finding M3)', () => {
    for (const text of [
      buildLearnInstructions({ sessionToken: TOKEN, topicSlug: 'sql' }),
      buildOnboardingInstructions({ sessionToken: TOKEN }),
      buildReviewInstructions({ sessionToken: TOKEN }),
    ]) {
      expect(text).toContain('Learner-facing voice');
      expect(text).toContain('Memory bookkeeping is SILENT');
    }
  });

  it('review instructions carry the token, the quiz-driven procedure, and stay in budget', () => {
    const text = buildReviewInstructions({ sessionToken: TOKEN });
    expect(text).toContain(TOKEN);
    expect(text).toContain('Mode: REVIEW');
    expect(text).toContain('ui_push_quiz');
    expect(text).toContain('ONE concept at a time');
    expect(text).toContain('NEW questions');
    expect(text).toContain('SM-2');
    expect(text).toContain('review(<topic>)');
    expect(text).toContain('ui_record_assessment');
    expect(text).toContain('memory skill');
    expect(text).toContain(REVIEW_KICKOFF_INPUT);
    expect(text).toContain('Never reveal this token');
    expect(estimateTokens(text)).toBeLessThanOrEqual(MODE_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('onboarding instructions carry the token, interview flow, and the exact init commit', () => {
    const text = buildOnboardingInstructions({ sessionToken: TOKEN });
    expect(text).toContain(TOKEN);
    expect(text).toContain('ONBOARDING');
    expect(text).toContain('profile.md');
    expect(text).toContain('ui_push_quiz');
    expect(text).toContain('confidence: low');
    expect(text).toContain('profile: initialize learner model');
    // QA finding p9c: the interview matches the 4 wizard step chips.
    expect(text).toContain('AT MOST 4');
    expect(estimateTokens(text)).toBeLessThanOrEqual(ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('onboarding file templates zod-validate against the shared schemas (QA finding M2)', () => {
    // The instructions must carry the templates verbatim…
    const text = buildOnboardingInstructions({ sessionToken: TOKEN });
    for (const snippet of Object.values(ONBOARDING_FILE_TEMPLATES)) {
      expect(text).toContain(snippet);
    }
    // …and the templates themselves must parse under the real schemas.
    expect(() =>
      profileFrontmatterSchema.parse(yamlLoad(ONBOARDING_FILE_TEMPLATES.profileFrontmatter)),
    ).not.toThrow();
    expect(() => trackFileSchema.parse(yamlLoad(ONBOARDING_FILE_TEMPLATES.track))).not.toThrow();
    expect(() =>
      masteryFileSchema.parse(yamlLoad(ONBOARDING_FILE_TEMPLATES.mastery)),
    ).not.toThrow();
    expect(() => srsQueueFileSchema.parse(yamlLoad(ONBOARDING_FILE_TEMPLATES.srs))).not.toThrow();
  });

  it('plan instructions carry valid inline templates and stay in budget', () => {
    const text = buildPlanInstructions({
      sessionToken: TOKEN,
      trackSlug: 'sql-interview',
      needsProfile: true,
      learnerName: 'Alex',
      intake: {
        subject: 'SQL Interview Prep',
        goalType: 'interview',
        sourceKind: 'job-description',
        sourceText: 'SQL joins and query optimization',
        currentLevel: 'intermediate',
        style: 'drill-first',
        totalDays: 5,
        studyDays: ['mon', 'wed', 'fri'],
        minutesPerDay: 45,
      },
    });
    for (const snippet of Object.values(PLAN_FILE_TEMPLATES)) expect(text).toContain(snippet);
    expect(() => trackFileSchema.parse(yamlLoad(PLAN_FILE_TEMPLATES.track))).not.toThrow();
    expect(() => roadmapFileSchema.parse(yamlLoad(PLAN_FILE_TEMPLATES.roadmap))).not.toThrow();
    expect(() =>
      trackBriefFrontmatterSchema.parse(yamlLoad(PLAN_FILE_TEMPLATES.briefFrontmatter)),
    ).not.toThrow();
    expect(text).toContain('profile: initialize learner model');
    expect(text).toContain('preferences.style: socratic');
    expect(estimateTokens(text)).toBeLessThanOrEqual(PLAN_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('track learn instructions compose teach/revise/mistakes context', () => {
    const base = {
      sessionToken: TOKEN,
      topicSlug: 'sql',
      trackSlug: 'sql-interview',
      roadmapDay: 3,
      dayTitle: 'JOIN foundations',
      daySubtopics: ['Join keys', 'INNER JOIN result shapes'],
    } as const;
    const teach = buildLearnInstructions({ ...base, intent: 'teach' });
    expect(teach).toContain('Day 3');
    expect(teach).toContain('tracks/sql-interview/brief.md');
    expect(teach).toContain('roadmap_day: 3');
    expect(teach).toContain('ui_session_wrap');
    const revise = buildLearnInstructions({ ...base, intent: 'revise' });
    expect(revise).toContain('REVISION');
    expect(revise).toContain('retrieval practice first');
    const mistakes = buildLearnInstructions({
      ...base,
      intent: 'mistakes',
      mistakesEvidence: 'Exercise ex-7 failed: WHERE removed NULL rows',
    });
    expect(mistakes).toContain('Exercise ex-7 failed');
    expect(mistakes).toContain('actual mistakes');
  });
});

describe('buildContextEnvelope', () => {
  it('wraps the digest in a labeled system-context block ending before the user text', () => {
    const envelope = buildContextEnvelope('[LEARNER STATE 2026-07-17]\ndigest body');
    expect(envelope).toContain('<eduagent-context>');
    expect(envelope).toContain('[LEARNER STATE 2026-07-17]');
    expect(envelope).toContain('</eduagent-context>');
    expect(envelope.trimEnd().endsWith('The learner says:')).toBe(true);
    expect(envelope).not.toContain('REPAIR FIRST');
  });

  it('adds the repair directive when files need fixing', () => {
    const envelope = buildContextEnvelope('digest', {
      needsRepair: ['topics/sql/mastery.yaml'],
    });
    expect(envelope).toContain('REPAIR FIRST');
    expect(envelope).toContain('topics/sql/mastery.yaml');
  });

  it('includes extra notes inside the context block', () => {
    const envelope = buildContextEnvelope('digest', { notes: ['Due concepts: sql/inner-join'] });
    const noteIndex = envelope.indexOf('Due concepts');
    expect(noteIndex).toBeGreaterThan(-1);
    expect(noteIndex).toBeLessThan(envelope.indexOf('</eduagent-context>'));
  });
});

describe('formatReviewDueNotes', () => {
  const model = (items: LearnerModel['srs']['items']): LearnerModel => ({
    profile: null,
    tracks: [],
    roadmaps: [],
    topics: [
      {
        topic: 'sql',
        displayName: 'SQL',
        mastery: {
          topic: 'sql',
          display_name: 'SQL',
          updated: '2026-07-16T00:00:00Z',
          concepts: [
            {
              id: 'inner-join',
              name: 'INNER JOIN',
              mastery: 0.7,
              confidence: 'medium',
              last_assessed: '2026-07-10',
              review_count: 1,
              prereqs: [],
              evidence: [{ date: '2026-07-10', note: 'x' }],
            },
          ],
        },
        openMisconceptions: [],
      },
    ],
    srs: { items },
    lastSession: null,
    needsRepair: [],
  });
  const now = new Date('2026-07-16T12:00:00Z');

  it('lists due items top-down with names and overdue markers', () => {
    const notes = formatReviewDueNotes(
      model([
        { concept: 'inner-join', topic: 'sql', due: '2026-07-14', interval_days: 3, ease: 2.5, lapses: 0 },
        { concept: 'left-join', topic: 'sql', due: '2026-07-16', interval_days: 1, ease: 2.5, lapses: 0 },
        { concept: 'later-one', topic: 'sql', due: '2026-07-20', interval_days: 5, ease: 2.5, lapses: 0 },
      ]),
      now,
    );
    const text = notes.join('\n');
    expect(notes[0]).toContain('REVIEW DUE (2 concepts, 1 overdue)');
    expect(text).toContain('sql/inner-join (INNER JOIN) — due 2026-07-14 (overdue)');
    expect(text).toContain('sql/left-join — due 2026-07-16');
    expect(text).not.toContain('later-one');
    // Overdue first.
    expect(text.indexOf('inner-join')).toBeLessThan(text.indexOf('left-join'));
  });

  it('an empty queue tells the agent to close, not invent reviews', () => {
    const text = formatReviewDueNotes(model([]), now).join('\n');
    expect(text).toContain('nothing is due');
    expect(text).toContain('do not invent reviews');
  });
});

describe('skill sources (plans/03 §6.1–6.2)', () => {
  it('both skills exist with codex-discoverable frontmatter', async () => {
    for (const name of SKILL_NAMES) {
      const source = await readSkillSource(name);
      expect(source.startsWith('---\n')).toBe(true);
      expect(source).toContain(`name: ${name}`);
      expect(source).toMatch(/description: .+/);
    }
  });

  it('teach skill carries the core pedagogy directives', async () => {
    const teach = await readSkillSource('teach');
    expect(teach).toContain('150 words');
    expect(teach).toContain('zone of proximal development');
    expect(teach).toContain('Socratic');
    expect(teach).toContain('twice on the same point');
    expect(teach).toContain('once or twice per session');
    expect(teach).toContain('.exercises/<id>/tests/');
    for (const tool of [
      'ui_push_exercise',
      'ui_grade_exercise',
      'ui_push_quiz',
      'ui_push_artifact',
    ]) {
      expect(teach).toContain(tool);
    }
    expect(teach).toContain('Never the full solution on a first failure');
    expect(teach).toContain('sessions/<date>-<slug>.md');
  });

  it('memory skill embeds the file formats, constraints, SRS rules, and grammar', async () => {
    const memory = await readSkillSource('memory');
    expect(memory).toContain('±0.35');
    expect(memory).toContain('never deleted');
    expect(memory).toContain('mastery.yaml');
    expect(memory).toContain('misconceptions.md');
    expect(memory).toContain('srs/queue.yaml');
    expect(memory).toContain('ease += 0.05');
    expect(memory).toContain('max(1.3, ease - 0.2)');
    expect(memory).toContain('<type>(<topic>): <headline>');
    expect(memory).toContain('learn, review, exam, misconception, profile, seed, system');
    expect(memory).toContain('ui_record_assessment');
    expect(memory).toContain('every learning event');
  });

  it('every example commit message in the memory skill parses under the shared grammar', async () => {
    const memory = await readSkillSource('memory');
    const fences = [...memory.matchAll(/```\n([^`]+?)```/g)].map((m) => m[1]!.trim());
    const examples = fences.filter((block) =>
      /^(learn|review|exam|misconception|profile|seed|system)[(:]/.test(block),
    );
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const example of examples) {
      expect(parseCommit(example), `should parse:\n${example}`).not.toBeNull();
    }
  });
});
