/**
 * `parseArgs` splits `--flag=value`, but the switch cases ignored the value:
 * `--writable=false` granted the tier it was written to deny.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequirementIntakeMcpToolHost } from '../src/adapter.js';
import { main, parseArgs } from '../src/main.js';

vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const parse = (argv: string[]) =>
  parseArgs(argv, {} as never) as unknown as Record<string, unknown>;

describe('requirement-intake-mcp: privilege switches with an inline value', () => {
  it('true / 1 grant; false / 0 / anything else deny', () => {
    expect(parse(['--writable']).writable).toBe(true);
    expect(parse(['--writable=true']).writable).toBe(true);
    expect(parse(['--writable=1']).writable).toBe(true);
    expect(parse(['--writable=false']).writable).toBe(false);
    expect(parse(['--writable=0']).writable).toBe(false);
    expect(parse(['--writable=yes-please']).writable).toBe(false);
  });

  it('clears tokenMissing on WRONGSTACK_MCP_TOKEN fallback and removes both signal listeners on HTTP shutdown (F73)', async () => {
    const parsed = parseArgs(['--project-root', '/tmp/proj', '--token', ''], {
      WRONGSTACK_MCP_TOKEN: 'env-token-123',
    });
    expect(parsed.httpToken).toBe('env-token-123');
    expect(parsed.tokenMissing).toBe(false);

    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    let readyResolve!: () => void;
    const readyPromise = new Promise<void>((r) => {
      readyResolve = r;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.includes('ready at http://')) readyResolve();
      return true;
    });

    try {
      const runPromise = main(['--project-root', process.cwd(), '--http', '--port', '0']);
      await readyPromise;
      process.emit('SIGINT', 'SIGINT');
      await expect(runPromise).resolves.toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('allows --writable=false to disable an earlier --writable flag and rejects non-object tool args (F132)', async () => {
    expect(parse(['--writable', '--writable=false']).writable).toBe(false);
    expect(parse(['--writable', '--writable=0']).writable).toBe(false);

    const host = createRequirementIntakeMcpToolHost('/tmp/p', {
      writable: true,
      dependencies: {
        resolveProjectId: async () => 'proj-1',
        service: { listIntakes: async () => [] } as any,
      },
    });
    const res = await host.callTool(
      'requirement_intake_list',
      [] as unknown as Record<string, unknown>,
    );
    expect(res.isError).toBe(true);
  });
});
