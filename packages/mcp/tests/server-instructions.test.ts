/**
 * `mcpServerInstructionsSection`: the connected servers' `initialize`
 * instructions as one system-prompt section. The end-to-end path (a real stdio
 * server through the ACP session wiring) is covered in
 * packages/cli/tests/acp-mcp-instructions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_INSTRUCTIONS_MAX_CHARS,
  mcpServerInstructionsSection,
} from '../src/server-instructions.js';

const registry = (servers: Record<string, string | undefined>) => ({
  list: () => Object.keys(servers).map((name) => ({ name })),
  getCatalog: (name: string) => ({ serverMetadata: { instructions: servers[name] } }),
});

describe('mcpServerInstructionsSection', () => {
  it('lists each server that sent instructions under its own heading', () => {
    const section = mcpServerInstructionsSection(
      registry({ agora: '  You run inside Agora.  ', silent: undefined, files: 'Use read_file.' }),
    );
    expect(section).toBe(
      [
        '# MCP server instructions',
        'Connected MCP servers sent these instructions about their own tools.',
        '',
        '## agora\nYou run inside Agora.\n\n## files\nUse read_file.',
      ].join('\n'),
    );
  });

  it('renders nothing when no server sent instructions', () => {
    expect(mcpServerInstructionsSection(registry({ a: undefined, b: '   ' }))).toBeUndefined();
    expect(mcpServerInstructionsSection(registry({}))).toBeUndefined();
  });

  it('caps one oversized server instead of letting it crowd out the prompt', () => {
    const section = mcpServerInstructionsSection(
      registry({ big: 'x'.repeat(MCP_INSTRUCTIONS_MAX_CHARS + 50) }),
    );
    expect(section).toContain('[instructions truncated]');
    expect(section!.length).toBeLessThan(MCP_INSTRUCTIONS_MAX_CHARS + 200);
  });

  it('skips a server whose catalog is gone', () => {
    const section = mcpServerInstructionsSection({
      list: () => [{ name: 'gone' }, { name: 'here' }],
      getCatalog: (name: string) =>
        name === 'here' ? { serverMetadata: { instructions: 'Hello.' } } : undefined,
    });
    expect(section).toContain('## here\nHello.');
    expect(section).not.toContain('## gone');
  });
});
