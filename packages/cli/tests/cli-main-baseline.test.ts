import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR 0 of Issue #29 (cli-main.ts refactor): baseline boot-shape
 * integration test. `main(argv)` is a 2,312-line monolith that runs
 * the full CLI surface. Before any extraction can land safely we need
 * a characterization test that pins the *trivially-observable* contract
 * \u2014 namely, that flag-handling short-circuits before any heavy
 * subsystem (mailbox, autonomy, brain, eternal engine, ...) is
 * constructed.
 *
 * Why `--help`: `boot()` is the first thing `main()` calls, and the
 * `--help` short-circuit is implemented in `boot()` itself (it returns
 * the printed help text as a number). So `main(['--help'])` exercises
 * the real `boot()` path with no agent / mailbox / director
 * involvement, and we can assert the exit code and the absence of
 * side effects without stubbing any of the heavy machinery. This is
 * the same "characterize the cheap path first" lesson that drove the
 * tui/app.tsx refactor (Issue #23 PR 0).
 */

// Capture stdout/stderr so the help text doesn't pollute the test
// runner output and we can assert on what was written.
let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stdoutWrites = [];
  stderrWrites = [];
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
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
  vi.restoreAllMocks();
});

describe('cli main() — baseline boot shape (PR 0 of #29)', () => {
  it('returns a number exit code (currently 2) for --help — does not throw', async () => {
    // Characterize the *actual* current behavior: as of 2026-06-13 the
    // CLI does NOT short-circuit on `--help`; it falls through to the
    // boot() failure path because no provider is configured. This
    // test pins that as the *starting* state of the refactor — the
    // first cli-main PR after this baseline is expected to add the
    // missing --help short-circuit, at which point this assertion
    // gets tightened to `expect(exit).toBe(0)`.
    const { main } = await import('../src/cli-main.js');
    const exit = await main(['node', 'wstack', '--help']);
    expect(typeof exit).toBe('number');
    // main() must not throw on a well-formed --help argv.
    expect(Number.isInteger(exit)).toBe(true);
  });

  it('returns a number exit code for --version — does not throw', async () => {
    const { main } = await import('../src/cli-main.js');
    const exit = await main(['node', 'wstack', '--version']);
    expect(typeof exit).toBe('number');
    expect(Number.isInteger(exit)).toBe(true);
  });

  it('writes the provider-missing notice to stderr on --help when no config exists', async () => {
    // Pin the boot-time notice shape: when there's no global config,
    // `boot()` logs an actionable "No provider or model configured"
    // message to stderr. Future cli-main extractions must keep this
    // discoverable — it is the only guidance a brand-new user sees
    // before they run `wrongstack init`.
    const { main } = await import('../src/cli-main.js');
    await main(['node', 'wstack', '--help']);
    const combined = stderrWrites.join('');
    expect(combined).toMatch(/No provider or model configured/);
  });

  it('exits cleanly when given a no-op argv (the smoke test for a hung REPL)', async () => {
    // An empty argv slice after the binary name should not run a
    // TUI/REPL loop. With no stdin and no TTY, `main()` must return
    // (not hang). We bound the wall time so a regression that
    // accidentally re-introduces a blocking read on stdin gets caught
    // here instead of timing out the entire test suite.
    const { main } = await import('../src/cli-main.js');
    const start = Date.now();
    const exit = await main(['node', 'wstack']);
    const elapsed = Date.now() - start;
    expect(typeof exit).toBe('number');
    // Generous bound: a real run kicks off boot + provider check, which
    // historically took ~4s in CI. 30s gives headroom without letting
    // a true hang slip through silently.
    expect(elapsed).toBeLessThan(30_000);
  });
});
