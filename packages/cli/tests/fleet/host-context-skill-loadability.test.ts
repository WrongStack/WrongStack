/**
 * A skill this role cannot load must neither occupy an eager slot nor take the
 * project's learning about it down with it.
 *
 * Measured on this repo before the fix: `reviewer` ranked `testing` (needs
 * `verification.run`, which a read-only reviewer lacks) into its top three on
 * every spawn — 6 142 spawns ran on two skills, and `testing`/`code-review`/
 * `security-scanner` read `loaded: 0` beside 110 distilled directives.
 * `explore-companion` had 179 directives on `node-modern` (needs
 * `filesystem.write`) that no spawn ever received.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SubagentConfig } from '@wrongstack/contracts/types';
import {
  eagerRoleSkills,
  loadSkillAffinity,
  recordSkillLearned,
  saveProjectSkillAugmentation,
} from '@wrongstack/core/agent-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHostSubagentSkillResolution } from '../../src/fleet/host-context.js';
import type { MultiAgentDeps } from '../../src/fleet/host-types.js';

let projectRoot: string;

const BODIES: Record<string, string> = {
  chimera: 'C'.repeat(500),
  'bug-hunter': 'B'.repeat(500),
  'security-scanner': 'S'.repeat(500),
  testing: 'T'.repeat(500),
  'code-review': 'R'.repeat(500),
};

/** `testing` needs a capability the (tool-less) test agent does not have. */
function deps(): MultiAgentDeps {
  return {
    projectRoot,
    skillLoader: {
      async find(name: string) {
        if (!BODIES[name]) return undefined;
        return name === 'testing' ? { name, requiredCapabilities: ['verification.run'] } : { name };
      },
      async readSaveBody(name: string) {
        return BODIES[name] ?? '';
      },
    },
    container: { safeResolve: () => undefined },
    events: { emit: () => {} },
    session: { id: 's1' },
  } as unknown as MultiAgentDeps;
}

const reviewer = { role: 'reviewer' } as unknown as SubagentConfig;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-skill-loadability-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('skill loadability at spawn', () => {
  it('fills every eager slot with a skill the role can load', async () => {
    // The addendum ranks `testing` first, exactly as it did in the real repo.
    saveProjectSkillAugmentation('reviewer', 'testing', 'TESTING-PRACTICE-MARKER', projectRoot);

    const report = await resolveHostSubagentSkillResolution(deps(), {}, reviewer);

    expect(report.dropped['testing']).toBe('missing-capability');
    expect(report.selected).toHaveLength(3);
    expect(report.selected).not.toContain('testing');
  });

  it('delivers the addendum of a skill the role can never load, on its own', async () => {
    saveProjectSkillAugmentation('reviewer', 'testing', 'TESTING-PRACTICE-MARKER', projectRoot);

    const report = await resolveHostSubagentSkillResolution(deps(), {}, reviewer);

    expect(report.addendumOnly).toEqual(['testing']);
    expect(report.content).toContain('## Project practice: testing');
    expect(report.content).toContain('TESTING-PRACTICE-MARKER');
    // The bundled method itself is not smuggled in with it.
    expect(report.content).not.toContain('T'.repeat(500));
  });

  it('records the block so surfaces without a skill loader stop listing it as eager', async () => {
    saveProjectSkillAugmentation('reviewer', 'testing', 'TESTING-PRACTICE-MARKER', projectRoot);
    const candidates = ['chimera', 'bug-hunter', 'security-scanner', 'testing', 'code-review'];
    // Before any spawn the addendum ranks `testing` into the displayed slice.
    expect(eagerRoleSkills('reviewer', candidates, projectRoot)).toContain('testing');

    await resolveHostSubagentSkillResolution(deps(), {}, reviewer);

    expect(loadSkillAffinity('reviewer', projectRoot).entries['testing']?.blocked).toBe(
      'missing-capability',
    );
    expect(eagerRoleSkills('reviewer', candidates, projectRoot)).not.toContain('testing');
  });

  it('leaves out the addendum of a loadable skill that merely ranked below the slice', async () => {
    for (const skill of ['chimera', 'bug-hunter', 'code-review']) {
      for (let i = 0; i < 5; i++) recordSkillLearned('reviewer', skill, projectRoot);
    }
    saveProjectSkillAugmentation(
      'reviewer',
      'security-scanner',
      'SECURITY-PRACTICE-MARKER',
      projectRoot,
    );

    const report = await resolveHostSubagentSkillResolution(deps(), {}, reviewer);

    expect(report.selected).toEqual(['chimera', 'bug-hunter', 'code-review']);
    expect(report.addendumOnly).toEqual([]);
    expect(report.content).not.toContain('SECURITY-PRACTICE-MARKER');
  });
});
