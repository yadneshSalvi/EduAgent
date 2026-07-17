import { load as yamlLoad } from 'js-yaml';
import {
  masteryFileSchema,
  profileFrontmatterSchema,
  srsQueueFileSchema,
  trackFileSchema,
} from '@eduagent/shared';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_FILE_TEMPLATES } from '../src/prompts/modes/onboarding.js';
import {
  buildContextEnvelope,
  buildLearnInstructions,
  buildOnboardingInstructions,
  estimateTokens,
  MODE_INSTRUCTIONS_TOKEN_BUDGET,
  ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET,
  readSkillSource,
  SKILL_NAMES,
} from '../src/prompts/index.js';
import { parseCommit } from '../src/workspace/index.js';

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
    ]) {
      expect(text).toContain('Learner-facing voice');
      expect(text).toContain('Memory bookkeeping is SILENT');
    }
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
