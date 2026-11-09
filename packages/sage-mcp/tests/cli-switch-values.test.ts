/**
 * `parseArgs` splits `--flag=value`, but the switch cases ignored the value:
 * `--writable=false` granted the tier it was written to deny.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli.js';

vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const parse = (argv: string[]) =>
  parseArgs(argv, {} as never) as unknown as Record<string, unknown>;

describe('sage-mcp: privilege switches with an inline value', () => {
  it('true / 1 grant; false / 0 / anything else deny', () => {
    expect(parse(['--writable']).writable).toBe(true);
    expect(parse(['--writable=true']).writable).toBe(true);
    expect(parse(['--writable=1']).writable).toBe(true);
    expect(parse(['--writable=false']).writable).toBe(false);
    expect(parse(['--writable=0']).writable).toBe(false);
    expect(parse(['--writable=yes-please']).writable).toBe(false);
  });

  it('clears tokenMissing when WRONGSTACK_MCP_TOKEN satisfies an empty --token flag (F73)', () => {
    const parsed = parseArgs(['--project-root', '/tmp/proj', '--token', ''], {
      WRONGSTACK_MCP_TOKEN: 'env-token-123',
    });
    expect(parsed.httpToken).toBe('env-token-123');
    expect(parsed.tokenMissing).toBe(false);
  });

  it('allows --writable=false / --writable=0 to override an earlier --writable flag (F134)', () => {
    expect(parse(['--writable', '--writable=false']).writable).toBe(false);
    expect(parse(['--writable=1', '--writable=0']).writable).toBe(false);
    expect(parse(['--writable=false', '--writable=true']).writable).toBe(true);
  });
});
