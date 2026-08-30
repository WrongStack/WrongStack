/**
 * Tests for tool-schema — normalizeMCPTools.
 */
import { describe, expect, it } from 'vitest';
import { normalizeMCPTools } from '../src/tool-schema.js';

describe('normalizeMCPTools', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeMCPTools(null)).toEqual([]);
    expect(normalizeMCPTools(undefined)).toEqual([]);
    expect(normalizeMCPTools('string')).toEqual([]);
    expect(normalizeMCPTools(42)).toEqual([]);
    expect(normalizeMCPTools({})).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(normalizeMCPTools([])).toEqual([]);
  });

  it('skips entries that are not objects', () => {
    const result = normalizeMCPTools(['string', 42, null]);
    expect(result).toEqual([]);
  });

  it('skips entries without a valid name', () => {
    const result = normalizeMCPTools([
      { name: '' },
      { name: '  ' },
      { name: 123 },
      { name: undefined },
    ]);
    expect(result).toEqual([]);
  });

  it('uses empty object schema when inputSchema is missing and trims name', () => {
    const result = normalizeMCPTools([{ name: '  test-tool  ' }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('test-tool');
    expect(result[0]!.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('uses provided inputSchema when valid', () => {
    const schema = { type: 'object', properties: { key: { type: 'string' } } };
    const result = normalizeMCPTools([{ name: 'valid-tool', inputSchema: schema }]);
    expect(result[0]!.inputSchema).toBe(schema);
  });

  it('defaults to empty schema when inputSchema is an array', () => {
    const result = normalizeMCPTools([
      { name: 'bad-schema', inputSchema: ['not', 'an', 'object'] },
    ]);
    expect(result[0]!.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('includes description when present', () => {
    const result = normalizeMCPTools([{ name: 'tool-with-desc', description: 'Does something' }]);
    expect(result[0]!.description).toBe('Does something');
  });

  it('omits description when not a string', () => {
    const result = normalizeMCPTools([
      { name: 'tool-bad-desc', description: 42 },
      { name: 'tool-no-desc' },
    ]);
    expect(result[0]!.description).toBeUndefined();
    expect(result[1]!.description).toBeUndefined();
  });

  it('normalizes multiple valid tools', () => {
    const result = normalizeMCPTools([
      { name: 'tool-a', description: 'First tool' },
      { name: 'tool-b', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('tool-a');
    expect(result[1]!.name).toBe('tool-b');
  });
});
