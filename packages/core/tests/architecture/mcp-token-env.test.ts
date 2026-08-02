/**
 * WS-064 — the MCP HTTP auth token was accepted only on the command line.
 *
 * `--token <value>` puts the secret where any local process can read it:
 * `/proc/<pid>/cmdline` is world-readable on Linux, `Win32_Process.CommandLine`
 * is readable by any process on Windows, and it lands in shell history either
 * way. An environment variable is not secret storage, but `/proc/<pid>/environ`
 * is restricted to the owning user — strictly better, and the interface CI
 * systems and secret managers already inject through.
 *
 * All four MCP CLIs had the identical shape. The behaviour is asserted against
 * mailbox-mcp (the file the finding cites) in
 * `packages/mailbox-mcp/tests/http-token-env.test.ts`. This is the ratchet that
 * keeps the other three from drifting back, or from a fifth MCP server shipping
 * with only the flag — importing four sibling packages into one test would mean
 * adding four dependencies for test-only reasons.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');

const MCP_CLIS = [
  'packages/mailbox-mcp/src/cli.ts',
  'packages/kanban-mcp/src/cli.ts',
  'packages/sage-mcp/src/cli.ts',
  'packages/codebase-index-mcp/src/cli.ts',
] as const;

function source(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), 'utf8');
}

function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe.each(MCP_CLIS)('%s', (file) => {
  it('accepts the HTTP token from the environment', () => {
    const body = code(source(file));
    expect(body).toContain("const HTTP_TOKEN_ENV = 'WRONGSTACK_MCP_TOKEN'");
    expect(body).toMatch(/env\[HTTP_TOKEN_ENV\]/);
  });

  it('takes its environment as a parameter rather than reading the global', () => {
    // Injectable env is what lets the behaviour be tested without mutating
    // `process.env` and leaking state across tests.
    expect(code(source(file))).toMatch(/env: NodeJS\.ProcessEnv = process\.env/);
  });

  it('still supports --token, so no existing invocation breaks', () => {
    // The fix is an added safe path, not a removed one. Deleting the flag
    // would be a breaking change dressed up as a security fix.
    expect(code(source(file))).toContain("case '--token':");
  });

  it('warns when the token arrives on the command line', () => {
    expect(code(source(file))).toMatch(/console\.warn\(/);
    expect(source(file)).toContain('WRONGSTACK_MCP_TOKEN');
  });

  it('documents the safer variable in --help', () => {
    // A mitigation nobody can discover is not a mitigation.
    expect(source(file)).toMatch(/Prefer WRONGSTACK_MCP_TOKEN/);
  });
});
