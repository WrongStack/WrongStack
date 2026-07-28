/**
 * Phase 1 characterization tests for cli-main.ts flag handling.
 *
 * Sibling to `cli-main-baseline.test.ts` (PR 0). The baseline pins exit
 * codes for `--help` / `--version` / no-op argv. These tests pin the
 * *content* of the flag short-circuit path and the NODE_ENV defaulting
 * side effect — two cheap, observable contracts that must survive the
 * planned boot-phase extraction (Issue #29 PRs 2-7).
 *
 * Both contracts are trivial to observe (stdout text / an env var) and
 * require no stubbing of the agent/provider/mailbox machinery, which is
 * exactly what Phase 1 of the refactor plan asks for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let originalNodeEnv: string | undefined;

beforeEach(() => {
  stdoutWrites = [];
  stderrWrites = [];
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  originalNodeEnv = process.env.NODE_ENV;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  delete process.env.WRONGSTACK_NODE_ENV_DEFAULTED;
  vi.restoreAllMocks();
});

describe('cli main() — flag short-circuit content (Phase 1)', () => {
  it('prints help text containing usage and the wstack binary name to stdout', async () => {
    const { main } = await import('../src/cli-entry-main.js');
    await main(['node', 'wstack', '--help']);
    const out = stdoutWrites.join('');
    expect(out.length).toBeGreaterThan(0);
    // The help surface names the binary so a user knows what to type next.
    expect(out).toMatch(/wstack|wrongstack/i);
    // And it surfaces the word "Usage" — every helpCmd flavour does.
    expect(out).toMatch(/Usage/i);
  });

  it('prints a version string to stdout for --version', async () => {
    const { main } = await import('../src/cli-entry-main.js');
    await main(['node', 'wstack', '--version']);
    const out = stdoutWrites.join('');
    expect(out.length).toBeGreaterThan(0);
    // versionCmd prints a dotted version number; pin the shape so a
    // regression that prints nothing (or a help dump) fails loudly.
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });

  it('defaults NODE_ENV to production and sets the marker on first run', async () => {
    delete process.env.NODE_ENV;
    delete process.env.WRONGSTACK_NODE_ENV_DEFAULTED;
    const { main } = await import('../src/cli-entry-main.js');
    await main(['node', 'wstack', '--help']);
    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.WRONGSTACK_NODE_ENV_DEFAULTED).toBe('1');
  });

  it('does not overwrite an explicit NODE_ENV', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.WRONGSTACK_NODE_ENV_DEFAULTED;
    const { main } = await import('../src/cli-entry-main.js');
    await main(['node', 'wstack', '--help']);
    expect(process.env.NODE_ENV).toBe('development');
    expect(process.env.WRONGSTACK_NODE_ENV_DEFAULTED).toBeUndefined();
  });
});
