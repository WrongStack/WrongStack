import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { McpComposerPicker } from '../src/McpComposerPicker';
import { parseToolInput, schemaFields, skeletonInput } from '../src/mcp-tool-input';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer' },
    exact: { type: 'boolean' },
    tags: { type: 'array' },
  },
  required: ['query', 'limit'],
};

describe('MCP tool input', () => {
  it('starts from the required properties with empty values of their type', () => {
    expect(skeletonInput(schema)).toEqual({ query: '', limit: 0 });
    expect(skeletonInput(undefined)).toEqual({});
  });

  it('accepts a JSON object or nothing, and says why anything else is refused', () => {
    expect(parseToolInput('{"query":"a"}')).toEqual({ ok: true, value: { query: 'a' } });
    expect(parseToolInput('  ')).toEqual({ ok: true, value: {} });
    expect(parseToolInput('[1]')).toEqual({
      ok: false,
      reason: 'object',
      error: 'The input must be a JSON object.',
    });
    const broken = parseToolInput('{query');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error).toMatch(/not valid JSON/);
  });

  it('lists the fields with the required ones first', () => {
    expect(
      schemaFields(schema).map((field) => `${field.name}${field.required ? '*' : ''}`),
    ).toEqual(['query*', 'limit*', 'exact', 'tags']);
  });
});

describe('MCP composer picker', () => {
  it('offers tools only when it can run them in a conversation', () => {
    const base = { command: async () => ({}), onInsert: async () => {}, onClose: () => {} };
    expect(renderToStaticMarkup(createElement(McpComposerPicker, base))).not.toContain(
      'Tools run as a step',
    );
    expect(
      renderToStaticMarkup(
        createElement(McpComposerPicker, { ...base, sessionId: 's1', onNotice: () => {} }),
      ),
    ).toContain('Tools run as a step of this conversation');
  });
});
