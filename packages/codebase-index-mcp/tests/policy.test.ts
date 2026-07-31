import { describe, expect, it } from 'vitest';
import { CODEBASE_INDEX_READ_TOOLS, selectCodebaseIndexMcpTools } from '../src/policy.js';

describe('Codebase Index MCP policy', () => {
  it('is read-only by default', () => {
    expect(selectCodebaseIndexMcpTools()).toEqual(CODEBASE_INDEX_READ_TOOLS);
    expect(selectCodebaseIndexMcpTools()).not.toContain('codebase_index');
  });

  it('adds the index writer only when explicitly writable', () => {
    expect(selectCodebaseIndexMcpTools({ writable: true })).toEqual([
      ...CODEBASE_INDEX_READ_TOOLS,
      'codebase_index',
    ]);
  });
});
