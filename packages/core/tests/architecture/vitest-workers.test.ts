import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVitestMaxWorkers } from '../../../../vitest.workers.js';

describe('Vitest worker CLI spellings', () => {
  beforeEach(() => vi.stubEnv('WRONGSTACK_VITEST_MAX_WORKERS', undefined));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [['-w=false'], 4],
    [['--watch=false'], 4],
    [['-w'], 2],
    [['-w=true'], 2],
  ])('maps %s to %s workers', (argv, expected) => {
    expect(getVitestMaxWorkers(argv)).toBe(expected);
  });

  it.each([
    ['run', '-w=true'],
    ['-w=true', 'run'],
    ['--run', '-w=true'],
    ['--watch=false', '-w=true'],
    ['run', '--watch=true'],
    ['run', '-w'],
  ])('prioritizes explicit watch intent in %s %s', (...argv) => {
    expect(getVitestMaxWorkers(argv)).toBe(2);
  });

  it('lets the explicit worker override win over conflicting run and short watch modes', () => {
    vi.stubEnv('WRONGSTACK_VITEST_MAX_WORKERS', '3');
    expect(getVitestMaxWorkers(['run', '-w=true'])).toBe(3);
  });

  it('lets the explicit worker override win for the short watch-disable alias', () => {
    vi.stubEnv('WRONGSTACK_VITEST_MAX_WORKERS', '8');
    expect(getVitestMaxWorkers(['-w=false'])).toBe(8);
  });
});
