import { describe, expect, it } from 'vitest';
import {
  mcpQualifiedToolName,
  mcpServerToolPrefix,
  sanitizeWireToolName,
  WIRE_TOOL_NAME_MAX_LENGTH,
  WIRE_TOOL_NAME_PATTERN,
} from '../../src/utils/tool-name.js';

describe('sanitizeWireToolName', () => {
  it('passes already-valid names through unchanged', () => {
    expect(sanitizeWireToolName('read_file')).toBe('read_file');
    expect(sanitizeWireToolName('mcp__srv__tool-1')).toBe('mcp__srv__tool-1');
  });

  it('replaces dots, colons, spaces and unicode with underscores', () => {
    expect(sanitizeWireToolName('claude.ai Gmail')).toBe('claude_ai_Gmail');
    expect(sanitizeWireToolName('ns:action')).toBe('ns_action');
    expect(sanitizeWireToolName('araç/çağır')).toBe('ara___a__r');
  });

  it('clamps to the 128-char wire limit', () => {
    const long = sanitizeWireToolName('a'.repeat(500));
    expect(long).toHaveLength(WIRE_TOOL_NAME_MAX_LENGTH);
    expect(long).toMatch(WIRE_TOOL_NAME_PATTERN);
  });

  it('falls back to "tool" for empty input', () => {
    expect(sanitizeWireToolName('')).toBe('tool');
  });
});

describe('mcpQualifiedToolName / mcpServerToolPrefix', () => {
  it('builds a prefix-consistent qualified name', () => {
    const qualified = mcpQualifiedToolName('claude.ai Gmail', 'search:messages');
    expect(qualified).toBe('mcp__claude_ai_Gmail__search_messages');
    expect(qualified.startsWith(mcpServerToolPrefix('claude.ai Gmail'))).toBe(true);
    expect(qualified).toMatch(WIRE_TOOL_NAME_PATTERN);
  });

  it('clamps the combined name while preserving the server prefix', () => {
    const qualified = mcpQualifiedToolName('srv', 'x'.repeat(300));
    expect(qualified).toHaveLength(WIRE_TOOL_NAME_MAX_LENGTH);
    expect(qualified.startsWith('mcp__srv__')).toBe(true);
  });
});
