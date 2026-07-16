import { describe, expect, it } from 'vitest';
import { clientWsEventSchema, wsEventSchema } from '../src/index';

describe('wsEventSchema', () => {
  it('parses message.delta', () => {
    const event = wsEventSchema.parse({ type: 'message.delta', itemId: 'item-1', text: 'Hel' });
    expect(event.type).toBe('message.delta');
    if (event.type === 'message.delta') expect(event.text).toBe('Hel');
  });

  it('parses a full memory.commit event', () => {
    const event = wsEventSchema.parse({
      type: 'memory.commit',
      commit: {
        sha: 'a1b2c3d',
        type: 'learn',
        topic: 'sql',
        headline: 'inner-join 0.40→0.72, left-join 0.20→0.40',
        bullets: ['Solved 2/3 join exercises without hints'],
        deltas: [
          { concept: 'inner-join', from: 0.4, to: 0.72 },
          { concept: 'left-join', from: 0.2, to: 0.4 },
        ],
        stats: { filesChanged: 2, insertions: 14, deletions: 3 },
        diff: 'diff --git a/topics/sql/mastery.yaml b/topics/sql/mastery.yaml\n…',
      },
    });
    expect(event.type).toBe('memory.commit');
    if (event.type === 'memory.commit') expect(event.commit.deltas).toHaveLength(2);
  });

  it('parses workbench.quiz with a client-checkable mcq question', () => {
    const event = wsEventSchema.parse({
      type: 'workbench.quiz',
      quiz: {
        id: 'quiz-031',
        concepts: ['inner-join'],
        questions: [
          {
            id: 'q-1',
            type: 'mcq',
            prompt_md: 'How many rows does this INNER JOIN return?',
            options: ['3', '5', '8'],
            answer: '5',
          },
        ],
      },
    });
    expect(event.type).toBe('workbench.quiz');
  });

  it('parses assessment.recorded with concept deltas', () => {
    const event = wsEventSchema.parse({
      type: 'assessment.recorded',
      concept_deltas: [
        { topic: 'sql', concept: 'inner-join', from: 0.4, to: 0.72, evidence: 'Solved ex-014' },
      ],
      misconceptions_resolved: ['Believes WHERE filters before JOIN completes'],
    });
    expect(event.type).toBe('assessment.recorded');
  });

  it('rejects an activity event with an unknown status', () => {
    const result = wsEventSchema.safeParse({
      type: 'activity',
      kind: 'exec',
      label: 'running tests…',
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  it('rejects turn.error without a retryable flag', () => {
    const result = wsEventSchema.safeParse({ type: 'turn.error', message: 'boom' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(wsEventSchema.safeParse({ type: 'user.message', text: 'hi' }).success).toBe(false);
    expect(wsEventSchema.safeParse({ type: 'nonsense' }).success).toBe(false);
  });
});

describe('clientWsEventSchema', () => {
  it('parses user.message and ping', () => {
    expect(clientWsEventSchema.parse({ type: 'user.message', text: 'teach me joins' }).type).toBe(
      'user.message',
    );
    expect(clientWsEventSchema.parse({ type: 'ping' }).type).toBe('ping');
  });

  it('rejects an empty user message', () => {
    expect(clientWsEventSchema.safeParse({ type: 'user.message', text: '' }).success).toBe(false);
  });
});
