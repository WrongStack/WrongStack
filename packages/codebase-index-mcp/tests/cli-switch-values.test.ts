/**
 * `parseArgs` splits `--flag=value`, but the switch cases ignored the value:
 * `--writable=false` granted the tier it was written to deny.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCodebaseIndexMcpToolHost } from '../src/adapter.js';
import { parseArgs } from '../src/main.js';
import { codebaseIndexMcpWriteVariant } from '../src/policy.js';

vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const parse = (argv: string[]) =>
  parseArgs(argv, {} as never) as unknown as Record<string, unknown>;

describe('codebase-index-mcp: privilege switches with an inline value', () => {
  it('true / 1 grant; false / 0 / anything else deny', () => {
    expect(parse(['--writable']).writable).toBe(true);
    expect(parse(['--writable=true']).writable).toBe(true);
    expect(parse(['--writable=1']).writable).toBe(true);
    expect(parse(['--writable=false']).writable).toBe(false);
    expect(parse(['--writable=0']).writable).toBe(false);
    expect(parse(['--writable=yes-please']).writable).toBe(false);
    expect(parse(['--watch']).watch).toBe(true);
    expect(parse(['--watch=true']).watch).toBe(true);
    expect(parse(['--watch=1']).watch).toBe(true);
    expect(parse(['--watch=false']).watch).toBe(false);
    expect(parse(['--watch=0']).watch).toBe(false);
    expect(parse(['--watch=yes-please']).watch).toBe(false);
  });

  it('allows later --writable=false / --watch=0 to clear an earlier switch, honors --http=false / --help=false, and rejects non-object tool args (F120)', async () => {
    expect(parse(['--writable', '--writable=false']).writable).toBe(false);
    expect(parse(['--watch', '--watch=0']).watch).toBe(false);
    expect(parse(['--http=false']).transport).toBe('stdio');
    expect(parse(['--help=false']).help).toBe(false);
    expect(codebaseIndexMcpWriteVariant('codebase_atlas', { mode: ' WRITE ' })).toMatch(
      /writes files/,
    );
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      dependencies: { packageGraph: async () => ({ nodes: [], edges: [] }) },
    });
    await expect(
      host.callTool('codebase_package_graph', [] as unknown as Record<string, unknown>),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      host.callTool('codebase_package_graph', null as unknown as Record<string, unknown>),
    ).resolves.toMatchObject({ isError: true });
  });
});
