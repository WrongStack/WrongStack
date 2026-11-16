import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSkillOutcomes, recordSkillOutcomes } from '../src/skill-companion-outcomes.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('skill-companion-outcomes', () => {
  it('loads and updates UTF-8 BOM-prefixed outcomes.json without dropping history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-outcomes-bom-'));
    tempRoots.push(root);
    const dir = path.join(root, '.wrongstack', 'agents', 'skill-companion');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'outcomes.json'),
      `\uFEFF${JSON.stringify({
        version: 1,
        skills: { 'bug-hunter': { accepted: 3, declined: 0 } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      })}`,
      'utf8',
    );

    expect(loadSkillOutcomes(root).skills['bug-hunter']?.accepted).toBe(3);
    const updated = recordSkillOutcomes(root, { accepted: ['bug-hunter'], declined: [] });
    expect(updated?.skills['bug-hunter']?.accepted).toBe(4);
  });
});
