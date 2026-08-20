import { describe, expect, it } from 'vitest';
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
