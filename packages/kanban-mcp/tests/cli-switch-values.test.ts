/**
 * `parseArgs` splits `--flag=value`, but the switch cases ignored the value:
 * `--writable=false` granted the tier it was written to deny.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/main.js';

vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const parse = (argv: string[]) =>
  parseArgs(argv, {} as never) as unknown as Record<string, unknown>;

describe('kanban-mcp: privilege switches with an inline value', () => {
  it('true / 1 grant; false / 0 / anything else deny', () => {
    expect(parse(['--writable']).writable).toBe(true);
    expect(parse(['--writable=true']).writable).toBe(true);
    expect(parse(['--writable=1']).writable).toBe(true);
    expect(parse(['--writable=false']).writable).toBe(false);
    expect(parse(['--writable=0']).writable).toBe(false);
    expect(parse(['--writable=yes-please']).writable).toBe(false);
  });

  it('--destructive=false grants neither destructive nor writable', () => {
    expect(parse(['--destructive=false'])).toMatchObject({ destructive: false, writable: false });
    expect(parse(['--destructive'])).toMatchObject({ destructive: true, writable: true });
  });

  it('clears tokenMissing when WRONGSTACK_MCP_TOKEN satisfies an empty --token flag (F73)', () => {
    const parsed = parseArgs(['--project-root', '/tmp/proj', '--token', ''], {
      WRONGSTACK_MCP_TOKEN: 'env-token-123',
    });
    expect(parsed.httpToken).toBe('env-token-123');
    expect(parsed.tokenMissing).toBe(false);
  });

  it('allows later =false switches to revoke --writable/--destructive, rejects non-object args in callTool, and guards atomicity against non-finite weights (F125)', async () => {
    const { createKanbanMcpToolHost } = await import('../src/adapter.js');
    const { assessAtomicity } = await import('../../kanban/src/atomicity/assess.js');

    const parsed = parseArgs(
      [
        '--project-root',
        '/tmp/proj',
        '--destructive',
        '--destructive=false',
        '--writable=false',
        '--http=false',
        '--help=false',
      ],
      {},
    );
    expect(parsed.destructive).toBe(false);
    expect(parsed.writable).toBe(false);
    expect(parsed.transport).toBe('stdio');
    expect(parsed.help).toBe(false);

    const host = createKanbanMcpToolHost('/tmp/proj', {
      writable: true,
      dependencies: {
        executeKanban: async () => ({ ok: true }),
        getConnection: async () => null,
      },
    });
    const res = await host.callTool('kanban_read', null as unknown as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/plain object/);

    const assessment = assessAtomicity(
      {
        title: 'Task',
        description: 'Desc',
        estimatedHours: 2,
        dependencyCount: 1,
        expectedFileChangeCount: 1,
        successCriteriaCount: 1,
        hasVerifiableOutput: true,
        childCount: 0,
      },
      {
        maxEstimatedHours: Number.NaN,
        weights: { effort: Number.POSITIVE_INFINITY },
      },
    );
    expect(Number.isFinite(assessment.score)).toBe(true);
    expect(assessment.verdict).toBe('atomic');
  });
});
