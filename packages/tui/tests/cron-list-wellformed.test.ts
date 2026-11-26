import { describe, expect, it } from 'vitest';
import { renderCronList } from '../src/cron-slash.js';

const ROCKET = '\u{1F680}';

function job(name: string, action: string) {
  return {
    name,
    intervalMs: 60_000,
    action,
    enabled: true,
    lastRun: null,
    nextRun: new Date(0).toISOString(),
    runCount: 0,
    overdue: false,
  };
}

/**
 * F2644: the wakeup list caps the action at 47 and the name at 21 UTF-16 units
 * with a plain `.slice`. Actions are model prompts, so an astral character at
 * the cut leaves a lone surrogate in the rendered list.
 */
describe('cron list keeps valid UTF-16 (F2644)', () => {
  it('drops the orphaned half in the action', () => {
    const out = renderCronList({
      ok: true,
      count: 1,
      maxConcurrent: 4,
      jobs: [job('plain', `${'a'.repeat(46)}${ROCKET}tail`)],
    });

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('a'.repeat(46));
  });

  it('drops the orphaned half in the name', () => {
    const out = renderCronList({
      ok: true,
      count: 1,
      maxConcurrent: 4,
      jobs: [job(`${'n'.repeat(20)}${ROCKET}tail`, 'plain action')],
    });

    expect(out.isWellFormed()).toBe(true);
  });

  it('renders ordinary rows unchanged (control)', () => {
    const out = renderCronList({
      ok: true,
      count: 1,
      maxConcurrent: 4,
      jobs: [job('plain', 'plain action')],
    });

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('plain action');
  });
});
