/**
 * WS-064 — the MCP HTTP auth token was accepted only on the command line.
 *
 * `--token <value>` puts the secret where any local process can read it:
 * `/proc/<pid>/cmdline` is world-readable on Linux, `Win32_Process.CommandLine`
 * is readable by any process on Windows, and it lands in shell history either
 * way. An environment variable is NOT secret storage — but
 * `/proc/<pid>/environ` is restricted to the owning user, so it is strictly
 * better than the command line, and it is the interface CI systems and secret
 * managers already inject through.
 *
 * All four MCP CLIs (mailbox, kanban, sage, codebase-index) had the same shape
 * and all four were fixed. This file asserts the BEHAVIOUR against the one the
 * finding cites; the other three are covered by a source-shape ratchet in
 * `packages/core/tests/architecture/mcp-token-env.test.ts`, because importing
 * sibling packages here would mean either adding four dependencies or reaching
 * across package roots with relative paths.
 *
 * `parseArgs` takes its environment as an injectable parameter precisely so
 * this can be asserted without mutating `process.env` and leaking state
 * between tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs as parseMailbox } from '../src/cli.js';

type Parser = (
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
) => { httpToken?: string | undefined };

const PARSERS: Array<[string, Parser]> = [['mailbox-mcp', parseMailbox as Parser]];

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PARSERS)('%s parseArgs (WS-064)', (_name, parseArgs) => {
  it('reads the token from WRONGSTACK_MCP_TOKEN', () => {
    const parsed = parseArgs(['--http'], { WRONGSTACK_MCP_TOKEN: 'env-secret' });
    expect(parsed.httpToken).toBe('env-secret');
  });

  it('trims surrounding whitespace, which shell exports pick up easily', () => {
    const parsed = parseArgs(['--http'], { WRONGSTACK_MCP_TOKEN: '  padded-secret\n' });
    expect(parsed.httpToken).toBe('padded-secret');
  });

  it('ignores an empty env var rather than setting an empty token', () => {
    // An empty token would look "configured" while authenticating nothing.
    expect(parseArgs(['--http'], { WRONGSTACK_MCP_TOKEN: '   ' }).httpToken).toBeUndefined();
    expect(parseArgs(['--http'], {}).httpToken).toBeUndefined();
  });

  it('lets an explicit --token win over the environment', () => {
    // Deliberate: an explicit argument overriding the ambient environment is
    // what a caller expects, and silently preferring the env var could route a
    // token the operator did not intend to use.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(['--http', '--token', 'flag-secret'], {
      WRONGSTACK_MCP_TOKEN: 'env-secret',
    });
    expect(parsed.httpToken).toBe('flag-secret');
    expect(warn).toHaveBeenCalled();
  });

  it('warns that --token is readable by other local processes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseArgs(['--http', '--token', 'flag-secret'], {});
    const message = warn.mock.calls.flat().join(' ');
    expect(message).toContain('WRONGSTACK_MCP_TOKEN');
    expect(message).toMatch(/command line/);
  });

  it('does not warn when the token came from the environment', () => {
    // The warning has to mean "you did the risky thing", or it becomes noise
    // on every correctly-configured start.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseArgs(['--http'], { WRONGSTACK_MCP_TOKEN: 'env-secret' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when no token is supplied at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseArgs(['--stdio'], {});
    expect(warn).not.toHaveBeenCalled();
  });
});
