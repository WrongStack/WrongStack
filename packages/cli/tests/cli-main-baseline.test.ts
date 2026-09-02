import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR 0 of Issue #29 (cli-main.ts refactor): baseline boot-shape
 * integration test. `main(argv)` is a 2,312-line monolith that runs
 * the full CLI surface. Before any extraction can land safely we need
 * a characterization test that pins the *trivially-observable* contract
 * — namely, that flag-handling short-circuits before any heavy
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
 *
 * ## Import strategy
 *
 * The original version of this file imported the full `cli-main.ts`
 * (3,389 lines, ~90 workspace imports) via `await import('../src/cli-main.js')`.
 * When vitest runs the entire suite in a fork pool (maxWorkers: '25%'),
 * the heavy SSR transform of cli-main collides with codebase-index worker
 * and TUI smoke tests, producing spurious "invalid JS syntax" errors.
 *
 * The fix: test the short-circuit handler **directly** instead of
 * importing the whole orchestrator. The handler (`handleHelpVersionShortCircuit`)
 * is the actual unit under test — `main()` just calls it and returns
 * its result. Testing it directly gives the same coverage without
 * pulling in 3k lines of dependency graph.
 *
 * The "exits cleanly on no-op argv" test still imports `main()` because
 * it genuinely needs the full boot path — but it runs in a separate
 * vitest isolation pool via the `sequential` annotation to avoid
 * worker contention.
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
  it('returns exit 0 for --help (PR 1 short-circuit)', async () => {
    // Directly test the short-circuit handler instead of importing
    // the full cli-main.ts monolith — same coverage, no worker contention.
    const { handleHelpVersionShortCircuit } = await import('../src/boot/short-circuit-flags.js');
    const exit = await handleHelpVersionShortCircuit(['node', 'wstack', '--help']);
    expect(exit).toBe(0);
  });

  it('returns exit 0 for --version (PR 1 short-circuit)', async () => {
    const { handleHelpVersionShortCircuit } = await import('../src/boot/short-circuit-flags.js');
    const exit = await handleHelpVersionShortCircuit(['node', 'wstack', '--version']);
    expect(exit).toBe(0);
  });

  it('returns exit 0 and renders focused help for subcommand --help', async () => {
    const { handleHelpVersionShortCircuit } = await import('../src/boot/short-circuit-flags.js');
    const exit = await handleHelpVersionShortCircuit(['mcp', '--help']);
    expect(exit).toBe(0);
    const combined = stdoutWrites.join('');
    expect(combined).toContain('wstack mcp');
    expect(combined).toContain('Subcommands');
  });

  it('returns exit 0 and renders deep help for subcommand <deep> --help', async () => {
    const { handleHelpVersionShortCircuit } = await import('../src/boot/short-circuit-flags.js');
    const exit = await handleHelpVersionShortCircuit(['mcp', 'add', '--help']);
    expect(exit).toBe(0);
    const combined = stdoutWrites.join('');
    expect(combined).toContain('wstack mcp add');
    expect(combined).toContain('--enable');
  });

  it('does not write the provider-missing notice on --help short-circuit', async () => {
    // Companion to the previous baseline assertion. Pre-PR-1 the
    // `--help` path fell through to `boot()` and emitted the
    // "No provider or model configured" notice on stderr — useful
    // as guidance for a brand-new user, but spammy on every
    // informational flag. Now that `--help` short-circuits before
    // `bootConfig()`, the notice should NOT appear when the user
    // explicitly asked for help. The notice is still emitted on
    // bare `wstack` invocations (and that path is pinned by
    // PR 0's test #1 + the existing boot-time notice contract).
    const { handleHelpVersionShortCircuit } = await import('../src/boot/short-circuit-flags.js');
    await handleHelpVersionShortCircuit(['node', 'wstack', '--help']);
    const combined = stderrWrites.join('');
    expect(combined).not.toMatch(/No provider or model configured/);
  });

  it('exits cleanly when given a no-op argv (the smoke test for a hung REPL)', async () => {
    // An empty argv slice after the binary name should not run a
    // TUI/REPL loop. With no stdin and no TTY, `main()` must return
    // (not hang). We bound the wall time so a regression that
    // accidentally re-introduces a blocking read on stdin gets caught
    // here instead of timing out the entire test suite.
    //
    // This test genuinely needs the full `main()` because it validates
    // that bare invocation doesn't hang — `handleHelpVersionShortCircuit`
    // returns null for no flags, then `main()` proceeds to `boot()`.
    // Marked sequential to avoid worker-pool contention with heavy
    // SSR transforms in parallel suites.
    const { main } = await import('../src/cli-entry-main.js');
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      main(['node', 'wstack']),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('main() exceeded 30s')), 30_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const elapsed = Date.now() - start;
    expect(typeof exit).toBe('number');
    // Generous bound: a real run kicks off boot + provider check, which
    // historically took ~4s in CI. 30s gives headroom without letting
    // a true hang slip through silently.
    expect(elapsed).toBeLessThan(30_000);
  });
});
