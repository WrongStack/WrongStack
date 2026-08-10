/**
 * The spawn skill budget must never spend its last bytes on a generic body at
 * the cost of the project's own learning.
 *
 * Measured on this repo's real `reviewer` role: chimera (11 KB body, 1.9 KB
 * addendum) + bug-hunter (12 KB body, no addendum) + testing (5 KB body, 2.2 KB
 * addendum) compose to 16 381 chars against a 16 000 budget, so `testing` — the
 * only one of the three carrying learning this project could not get anywhere
 * else — was dropped on every single spawn while 8 KB of generic body stayed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { saveProjectSkillAugmentation } from '@wrongstack/core/agent-catalog';
import type { SubagentConfig } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHostSubagentSkillResolution } from '../../src/fleet/host-context.js';
import type { MultiAgentDeps } from '../../src/fleet/host-types.js';

let projectRoot: string;

/** Skill loader over fixed bodies, mirroring the real loader's surface. */
function loader(bodies: Record<string, string>): MultiAgentDeps['skillLoader'] {
  return {
    async find(name: string) {
      return bodies[name] ? { name } : undefined;
    },
    async readSaveBody(name: string) {
      return bodies[name] ?? '';
    },
  } as unknown as MultiAgentDeps['skillLoader'];
}

function deps(bodies: Record<string, string>): MultiAgentDeps {
  return {
    projectRoot,
    skillLoader: loader(bodies),
    container: { safeResolve: () => undefined },
    events: { emit: () => {} },
    session: { id: 's1' },
  } as unknown as MultiAgentDeps;
}

const cfg = (skillNames: string[]): SubagentConfig =>
  ({ role: 'reviewer', skillNames }) as unknown as SubagentConfig;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-skill-budget-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('eager skill budget', () => {
  const bodies = {
    chimera: 'C'.repeat(11_434),
    'bug-hunter': 'B'.repeat(12_616),
    testing: 'T'.repeat(5_144),
  };

  /** Addendum of a given real-world size, with a marker that must survive. */
  const addendum = (bytes: number) =>
    `PROJECT-PRACTICE-MARKER\n${'X'.repeat(Math.max(0, bytes - 24))}`;

  it('keeps the project addendum and shortens the generic body instead', async () => {
    saveProjectSkillAugmentation('reviewer', 'chimera', addendum(1_926), projectRoot);
    saveProjectSkillAugmentation('reviewer', 'testing', addendum(2_174), projectRoot);

    const report = await resolveHostSubagentSkillResolution(
      deps(bodies),
      {},
      cfg(['chimera', 'bug-hunter', 'testing']),
    );

    expect(report.selected).toContain('testing');
    expect(report.dropped['testing']).toBeUndefined();
    expect(report.trimmed).toEqual(['testing']);
    expect(report.content).toContain('### Project practice for `testing`');
    expect(report.content).toContain('_(body trimmed)_');
    expect(report.content.length).toBeLessThanOrEqual(16_000 + 200);
  });

  it('still drops a skill outright when it has no project practice to protect', async () => {
    saveProjectSkillAugmentation('reviewer', 'chimera', addendum(4_500), projectRoot);

    const report = await resolveHostSubagentSkillResolution(
      deps(bodies),
      {},
      cfg(['chimera', 'bug-hunter', 'testing']),
    );

    expect(report.dropped['testing']).toBe('budget');
    expect(report.trimmed).toEqual([]);
  });

  it('drops rather than serving a body too short to be a method', async () => {
    saveProjectSkillAugmentation('reviewer', 'chimera', addendum(6_000), projectRoot);
    saveProjectSkillAugmentation('reviewer', 'testing', addendum(1_500), projectRoot);

    const report = await resolveHostSubagentSkillResolution(
      deps(bodies),
      {},
      cfg(['chimera', 'bug-hunter', 'testing']),
    );

    expect(report.dropped['testing']).toBe('budget');
  });

  it('leaves an entry untouched when it already fits', async () => {
    saveProjectSkillAugmentation('reviewer', 'testing', 'PROJECT-PRACTICE-MARKER', projectRoot);

    const report = await resolveHostSubagentSkillResolution(
      deps({ testing: 'T'.repeat(500) }),
      {},
      cfg(['testing']),
    );

    expect(report.trimmed).toEqual([]);
    expect(report.content).not.toContain('_(body trimmed)_');
    expect(report.content).toContain('PROJECT-PRACTICE-MARKER');
  });
});
