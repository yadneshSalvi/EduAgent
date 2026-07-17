import { z } from 'zod';
import { UI_TOOL_NAMES, uiToolArgSchemas, uiToolDescriptions } from '@eduagent/shared';

/**
 * MCP tool definitions GENERATED from the shared zod schemas (plans/03 §5 —
 * "the schemas ARE the contract"). Nothing here is hand-written: names come
 * from `uiToolArgSchemas`, JSON schemas from zod's own converter, prose from
 * `uiToolDescriptions`.
 */
export interface UiToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

export function buildUiToolDefinitions(): UiToolDefinition[] {
  return UI_TOOL_NAMES.map((name) => {
    // io:'input' renders what callers must SEND. Refinements (mcq-needs-options
    // etc.) are not representable in JSON Schema — the relay enforces them and
    // returns instructive errors the model can act on.
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(uiToolArgSchemas[name], {
      io: 'input',
    });
    return {
      name,
      description: uiToolDescriptions[name],
      inputSchema: jsonSchema as UiToolDefinition['inputSchema'],
    };
  });
}
