import { describe, expect, it } from 'vitest';
import { compilePathGlob, matchesAnyGuarded } from '../src/path-guard/glob.js';
import { destructiveTargets } from '../src/path-guard/shell-targets.js';

/**
 * Regression for the ReDoS found by the 2026-08-20 security-check audit.
 *
 * `XARGS_OPTIONS` had two alternatives that both matched a token like `-I`:
 * one consumed it as a value-taking option plus the following token, the other
 * consumed it alone as a flag. Every token forked the parse, giving exponential
 * backtracking in a regex that `destructiveTargets` runs SYNCHRONOUSLY on the
 * main thread over a model-supplied command string. Measured before the fix:
 * 731 ms at 110 characters, 19.7 s at 128, 52 s at 134 — an indirect prompt
 * injection could wedge the process with a short string.
 */

const BUDGET_MS = 1_000;

function timed(command: string): number {
  const start = performance.now();
  destructiveTargets(command);
  return performance.now() - start;
}

describe('xargs option scanning is not exponential', () => {
  // 134 characters cost ~52 SECONDS before the fix. A generous budget still
  // fails loudly if the ambiguity is ever reintroduced.
  it.each([40, 42, 48, 64])('stays fast for %i repeated option tokens', (n) => {
    expect(timed(`xargs${' -I'.repeat(n)} rm`)).toBeLessThan(BUDGET_MS);
  });

  it('stays fast for a pathologically long option run', () => {
    expect(timed(`xargs${' -I'.repeat(20_000)} rm`)).toBeLessThan(BUDGET_MS);
  });

  it('stays fast when the run never reaches a writer', () => {
    expect(timed(`xargs${' -n'.repeat(64)}`)).toBeLessThan(BUDGET_MS);
  });
});

describe('the fix did not weaken xargs writer detection', () => {
  // The regex exists so a writer launched through xargs is still inspected.
  // These are the forms the original probe (2026-08-17) established.
  it.each([
    'xargs -n 1 tee .env',
    'xargs -I {} tee .env',
    'xargs -I{} tee .env',
    'xargs -0 tee .env',
    'xargs --replace={} tee .env',
    'xargs -P 4 -n 1 tee .env',
    'xargs --max-args 5 tee .env',
  ])('still finds the writer target in %s', (command) => {
    expect(destructiveTargets(command).length).toBeGreaterThan(0);
  });

  it('still finds a writer with no xargs prefix at all', () => {
    expect(destructiveTargets('tee .env').length).toBeGreaterThan(0);
  });
});

/**
 * Audit T-02 (2026-08-22, re-verified with measurements): the glob compiler
 * emits a bounded vocabulary — `[^/]*`, `[^/]`, and `(?:[^/]+(?:/[^/]+)*)?`.
 * Negated classes cannot cross `/`, so segmentation is unambiguous and the
 * match is LINEAR per start position. The T-02 threat model (hostile
 * tool-supplied PATH against benign operator config globs) is therefore
 * bounded polynomial — never catastrophic backtracking. The genuinely
 * exponential shape needs a hostile CONFIG glob (`a*a*…*z`), which is
 * operator-supplied and outside the threat model — and the protect path
 * runs it behind the withReDoSGuard worker watchdog anyway (fail-closed).
 *
 * These tests pin the safe envelope so a future compiler change that breaks
 * linearity fails loudly here.
 */
describe('compilePathGlob adversarial-input timing (audit T-02)', () => {
  // CPU time, not wall-clock: these pins flaked under full-suite parallel
  // load, where scheduler preemption inflated wall time past the budget
  // while the actual regex work was unchanged. CPU time removes scheduling
  // noise, but NOTE: cache/memory-bandwidth contention from parallel
  // workers still inflates CPU cycles for the same work (measured >2s CPU
  // under load vs ~1.3s idle), so the budget carries headroom for that.
  // The pin's discrimination is exponential-vs-polynomial: the old xargs
  // ReDoS cost 52s at 134 chars — at this sweep's scale a reintroduced
  // exponential shape is minutes, so the split budgets below still fail
  // loudly on regression while tolerating parallel-load contention on the
  // healthy path.
  // Compile-only budget: measured 0.2ms CPU for the whole set — untouched.
  const COMPILE_BUDGET_MS = 5_000;
  // Hostile-path sweep budget, split from the compile budget after the
  // 2026-08-23 CI flake. Measured idle: ~1.3s CPU (≈65ms per pair). Measured
  // on a loaded CI runner: 5.07s CPU for the SAME work — cache/memory-
  // bandwidth contention from sibling workers inflates CPU cycles ~4x even
  // though `cpuTimed` already removes scheduler noise. 15s keeps ~3x
  // headroom over the worst observed CI measurement while preserving the
  // pin's discrimination: a reintroduced exponential shape costs MINUTES at
  // this 20-combination scale (the old xargs ReDoS: 52s at 134 chars), so
  // exponential-vs-polynomial still fails loudly at 15s.
  const SWEEP_BUDGET_MS = 15_000;
  function cpuTimed(fn: () => void): number {
    const start = process.cpuUsage();
    fn();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1_000;
  }

  it('compiles pathological glob shapes in bounded time', () => {
    const pathological = [
      'a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*z',
      '**/**/**/**/**/**/**/*.env',
      '****/****/****/****/****/****/****/****/****/****.env',
      `${'*/'.repeat(200)}.env`,
      '?'.repeat(200),
      `${'**/'.repeat(200)}package-lock.json`,
    ];
    const ms = cpuTimed(() => {
      for (const glob of pathological) compilePathGlob(glob);
    });
    // Measured: 0.2ms CPU for the whole set.
    expect(ms).toBeLessThan(COMPILE_BUDGET_MS);
  });

  it('benign protect globs match hostile paths without catastrophic backtracking', () => {
    const patterns = [
      compilePathGlob('**/package-lock.json'),
      compilePathGlob('.env'),
      compilePathGlob('**/migrations/*.sql'),
      compilePathGlob('.git/**'),
    ];
    const hostile = [
      `${'seg/'.repeat(10_000)}package-lock.json`,
      `${'a'.repeat(100_000)}.env`,
      `${'a'.repeat(50_000)}/`,
      `${'../'.repeat(5_000)}etc/passwd`,
      `${'a/'.repeat(20_000)}b/c/d/e/f/g.env`,
    ];
    // The full 20-combination sweep measured ~1.3s (≈65ms per pair) on this
    // scale — bounded polynomial (linear per start position), NOT the
    // exponential blowup ReDoS means (the old xargs bug: 52s at 134 chars).
    const ms = cpuTimed(() => {
      for (const re of patterns) for (const p of hostile) re.test(p);
    });
    expect(ms).toBeLessThan(SWEEP_BUDGET_MS);
  });

  it('matchesAnyGuarded contains a hostile-config worst case and fails CLOSED', async () => {
    // A pathological CONFIG glob (operator-supplied, outside the threat
    // model) against a hostile path. The worker watchdog must terminate it
    // within budget and report it as protected — a timeout can never read
    // as an exemption (bypass) or wedge the agent loop.
    const patterns = [compilePathGlob('a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*z')];
    const t0 = performance.now();
    const hit = await matchesAnyGuarded('a'.repeat(50_000), patterns);
    const ms = performance.now() - t0;
    // Measured: ~256ms (250ms budget + worker overhead). Generous outer bound.
    expect(ms).toBeLessThan(5_000);
    expect(hit).toBe(true);
  }, 10_000);
});
