import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isSkillSuppressed,
  loadSkillOutcomes,
  recordSkillOutcomes,
  skillOutcomesPath,
} from '@wrongstack/fleet';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wstack-skill-outcomes-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe('Skill Companion outcomes', () => {
  it('counts accepts and declines per skill', () => {
    const dir = root();
    recordSkillOutcomes(dir, { accepted: ['testing'], declined: ['pdf'] });
    recordSkillOutcomes(dir, { accepted: [], declined: ['pdf', 'Not A Name'] });
    const outcomes = loadSkillOutcomes(dir);
    expect(outcomes.skills['testing']).toMatchObject({ accepted: 1, declined: 0 });
    expect(outcomes.skills['pdf']).toMatchObject({ accepted: 0, declined: 2 });
    expect(Object.keys(outcomes.skills)).toEqual(['testing', 'pdf']);
  });

  it('suppresses a skill only while recent declines outweigh accepts', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const at = (ms: number) => new Date(ms).toISOString();
    expect(isSkillSuppressed({ accepted: 0, declined: 2, lastDeclinedAt: at(now) }, now)).toBe(
      false,
    );
    expect(isSkillSuppressed({ accepted: 0, declined: 3, lastDeclinedAt: at(now) }, now)).toBe(
      true,
    );
    // One accept cancels two declines.
    expect(isSkillSuppressed({ accepted: 1, declined: 4, lastDeclinedAt: at(now) }, now)).toBe(
      false,
    );
    expect(isSkillSuppressed({ accepted: 1, declined: 5, lastDeclinedAt: at(now) }, now)).toBe(
      true,
    );
    // A quiet month brings it back.
    expect(
      isSkillSuppressed({ accepted: 0, declined: 9, lastDeclinedAt: at(now - 31 * DAY) }, now),
    ).toBe(false);
    expect(isSkillSuppressed(undefined, now)).toBe(false);
  });

  it('never rewrites a file it cannot read', () => {
    const dir = root();
    const file = skillOutcomesPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(recordSkillOutcomes(dir, { accepted: ['testing'], declined: [] })).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    // Decisions read it as no history.
    expect(loadSkillOutcomes(dir).skills).toEqual({});
  });
});
