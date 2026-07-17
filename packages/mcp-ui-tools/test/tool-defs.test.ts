import { describe, expect, it } from 'vitest';
import { UI_TOOL_NAMES, uiToolArgSchemas } from '@eduagent/shared';
import { buildUiToolDefinitions } from '../src/tool-defs';

describe('buildUiToolDefinitions', () => {
  const defs = buildUiToolDefinitions();
  const byName = new Map(defs.map((d) => [d.name, d]));

  it('generates one definition per shared schema — the schemas ARE the contract', () => {
    expect(defs.map((d) => d.name)).toEqual(UI_TOOL_NAMES);
    expect(defs).toHaveLength(Object.keys(uiToolArgSchemas).length);
  });

  it('every tool requires session_token (plans/01 §4.5)', () => {
    for (const def of defs) {
      const required = def.inputSchema.required as string[];
      expect(required, def.name).toContain('session_token');
      const properties = def.inputSchema.properties as Record<string, unknown>;
      expect(properties.session_token, def.name).toMatchObject({ type: 'string' });
    }
  });

  it('has a non-empty description and an object schema without $schema noise', () => {
    for (const def of defs) {
      expect(def.description.length, def.name).toBeGreaterThan(20);
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema).not.toHaveProperty('$schema');
    }
  });

  it('renders the field shapes the relay will enforce (spot checks)', () => {
    const exercise = byName.get('ui_push_exercise')!;
    expect(exercise.inputSchema.required).toEqual(
      expect.arrayContaining(['id', 'title', 'language', 'prompt_md', 'starter_code', 'concepts', 'difficulty', 'tests_path']),
    );
    const properties = exercise.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.difficulty!.enum).toEqual(['easy', 'medium', 'hard']);

    const quiz = byName.get('ui_push_quiz')!;
    const quizProps = quiz.inputSchema.properties as Record<
      string,
      { items?: { properties?: Record<string, { enum?: string[] }> } }
    >;
    expect(quizProps.questions!.items!.properties!.type!.enum).toEqual([
      'mcq',
      'short',
      'predict_output',
    ]);
  });
});
