import { describe, expect, it } from 'vitest';
import {
  CODEBASE_INDEX_READ_TOOLS,
  CODEBASE_INDEX_WRITE_TOOLS,
  mcpToolNote,
  selectCodebaseIndexMcpTools,
} from '../src/policy.js';

describe('Codebase Index MCP policy', () => {
  it('is read-only by default', () => {
    expect(selectCodebaseIndexMcpTools()).toEqual(CODEBASE_INDEX_READ_TOOLS);
    for (const writeTool of CODEBASE_INDEX_WRITE_TOOLS) {
      expect(selectCodebaseIndexMcpTools()).not.toContain(writeTool);
    }
  });

  it('adds the write/execution tools only when explicitly writable', () => {
    expect(selectCodebaseIndexMcpTools({ writable: true })).toEqual([
      ...CODEBASE_INDEX_READ_TOOLS,
      ...CODEBASE_INDEX_WRITE_TOOLS,
    ]);
  });

  it('rewrites next-step notes to MCP tool names the client can call', () => {
    const note =
      'Next: codebase-read-symbol({ file: "a.ts", symbol: "f" }); then codebase-targeted-test({ file: "a.ts" }).';
    expect(mcpToolNote(note)).toBe(
      'Next: codebase_read_symbol({ file: "a.ts", symbol: "f" }); then codebase_targeted_test (needs --writable)({ file: "a.ts" }).',
    );
    expect(mcpToolNote(note, { writable: true })).toContain('codebase_targeted_test({ file');
    expect(mcpToolNote('Run dead-code-scan then dead-code-fix.')).toBe(
      'Run dead_code_scan then dead_code_fix (needs --writable).',
    );
    expect(mcpToolNote('Run dead-code-scan then dead-code-fix.', { writable: true })).toBe(
      'Run dead_code_scan then dead_code_fix.',
    );
    // Not an MCP tool: left as written.
    expect(mcpToolNote('see codebase-lsp-search')).toBe('see codebase-lsp-search');
  });
});
