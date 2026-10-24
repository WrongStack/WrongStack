import type { Tool } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { toolsToGemini } from '../src/presets/google.js';

/**
 * Gemini's function-declaration schema accepts `anyOf` but not `oneOf`. The
 * sanitizer dropped `oneOf` outright, so telegram's `chat_id`
 * (`oneOf: [string, integer]`) reached Gemini with only a description and no
 * type (audit 2026-09-15).
 */
function toolWith(inputSchema: Tool['inputSchema']): Tool {
  return {
    name: 'probe',
    description: 'probe tool',
    inputSchema,
    permission: 'auto',
    mutating: false,
    async execute() {
      return '';
    },
  };
}

function wireProperties(inputSchema: Tool['inputSchema']): Record<string, unknown> {
  const [decl] = toolsToGemini([toolWith(inputSchema)]);
  if (!decl) throw new Error('toolsToGemini returned no declaration');
  return (decl['parameters'] as { properties: Record<string, unknown> }).properties;
}

describe('Gemini schema sanitizer', () => {
  it('keeps a nested oneOf as anyOf instead of leaving the property untyped', () => {
    const properties = wireProperties({
      type: 'object',
      properties: {
        chat_id: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Target chat.',
        },
      },
    });
    expect(properties['chat_id']).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
      description: 'Target chat.',
    });
  });

  it('does not overwrite an existing anyOf with a sibling oneOf', () => {
    const properties = wireProperties({
      type: 'object',
      properties: {
        v: { anyOf: [{ type: 'boolean' }], oneOf: [{ type: 'string' }] },
      },
    });
    expect(properties['v']).toEqual({ anyOf: [{ type: 'boolean' }] });
  });
});
