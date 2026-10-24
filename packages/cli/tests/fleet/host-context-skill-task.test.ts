/**
 * Skills follow the task, not only the role.
 *
 * Before: a role's pool was served in project-affinity order whatever the
 * worker was asked to do, and a role-less worker (`delegate({ name })`) got no
 * pool at all — only the prompt's generic skill block in catalog order.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SubagentConfig } from '@wrongstack/contracts/types';
import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHostSubagentSkillResolution } from '../../src/fleet/host-context.js';
import type { MultiAgentDeps } from '../../src/fleet/host-types.js';

let projectRoot: string;

const CATALOG = [
  { name: 'angular-modern', description: 'Angular apps with modern wording and signals.' },
  { name: 'chimera', description: 'Multi-angle adversarial review.' },
  { name: 'bug-hunter', description: 'Find defects with proof.' },
  { name: 'code-review', description: 'Review a diff for correctness.' },
  { name: 'docker-deploy', description: 'Dockerfile and compose deployment.' },
  { name: 'security-scanner', description: 'Scan auth flows and secret handling.' },
];

function deps(): MultiAgentDeps {
  return {
    projectRoot,
    skillLoader: {
      async list() {
        return CATALOG;
      },
      async find(name: string) {
        return CATALOG.find((skill) => skill.name === name);
      },
      async readSaveBody(name: string) {
        return `BODY-OF-${name}`;
      },
    },
    container: { safeResolve: () => undefined },
    events: { emit: () => {} },
    session: { id: 's1' },
  } as unknown as MultiAgentDeps;
}

/** What `instantiateRosterConfig` hands the host: the catalog entry, copied whole. */
function rosterSpawn(role: string): SubagentConfig {
  const base = FLEET_ROSTER[role];
  if (!base) throw new Error(`no roster role ${role}`);
  return { ...base, id: `${role}-test` };
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-skill-task-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('task-aware skill selection', () => {
  it('moves the skill the task names to the front of a role pool', async () => {
    const reviewer = { role: 'reviewer' } as unknown as SubagentConfig;
    const untargeted = await resolveHostSubagentSkillResolution(deps(), {}, reviewer);
    expect(untargeted.selected[0]).not.toBe('security-scanner');

    const report = await resolveHostSubagentSkillResolution(
      deps(),
      {},
      reviewer,
      [],
      'Check the auth flow for security holes',
    );
    expect(report.selected[0]).toBe('security-scanner');
  });

  it('gives a role-less worker the skills its task names', async () => {
    const helper = { name: 'helper' } as unknown as SubagentConfig;
    const report = await resolveHostSubagentSkillResolution(
      deps(),
      {},
      helper,
      [],
      'Write a docker compose file for the api',
    );
    expect(report.selected).toEqual(['docker-deploy']);
    expect(report.content).toContain('BODY-OF-docker-deploy');
  });

  it('does not pick a skill on one shared description word, or with no task', async () => {
    const helper = { name: 'helper' } as unknown as SubagentConfig;
    const weak = await resolveHostSubagentSkillResolution(
      deps(),
      {},
      helper,
      [],
      'Tidy the wording in the changelog',
    );
    expect(weak.selected).toEqual([]);
    expect(weak.content).toBe('');

    const none = await resolveHostSubagentSkillResolution(deps(), {}, helper);
    expect(none.selected).toEqual([]);
  });

  it('ranks a real roster spawn instead of freezing it on the default slice', async () => {
    // A roster spawn copies its catalog entry, default `skillNames` included.
    const reviewer = rosterSpawn('reviewer');
    expect(reviewer.skillNames).toEqual(FLEET_ROSTER['reviewer']?.skillNames);
    const report = await resolveHostSubagentSkillResolution(
      deps(),
      FLEET_ROSTER,
      reviewer,
      [],
      'Check the auth flow for security holes',
    );
    // Frozen, the default slice led with `chimera` whatever the task said.
    expect(FLEET_ROSTER['reviewer']?.skillNames?.[0]).not.toBe('security-scanner');
    expect(report.selected[0]).toBe('security-scanner');
  });

  it('loads skills the leader requested first, without dropping the role pool', async () => {
    const reviewer = {
      ...rosterSpawn('reviewer'),
      requestedSkills: ['docker-deploy'],
    };
    const report = await resolveHostSubagentSkillResolution(deps(), FLEET_ROSTER, reviewer, []);
    expect(report.selected[0]).toBe('docker-deploy');
    expect(report.selected).toHaveLength(3);

    // An explicit empty list (companions) still means no skills at all.
    const companion = {
      name: 'c',
      skillNames: [],
      requestedSkills: ['docker-deploy'],
    } as unknown as SubagentConfig;
    expect((await resolveHostSubagentSkillResolution(deps(), {}, companion, [])).selected).toEqual(
      [],
    );
  });

  it('keeps a project override of a role skill list verbatim', async () => {
    const reviewer = {
      ...rosterSpawn('reviewer'),
      skillNames: ['code-review', 'chimera'],
    };
    const report = await resolveHostSubagentSkillResolution(
      deps(),
      FLEET_ROSTER,
      reviewer,
      [],
      'Check the auth flow for security holes',
    );
    expect(report.selected).toEqual(['code-review', 'chimera']);
  });

  it('keeps an explicit per-spawn skill list as given', async () => {
    const pinned = {
      name: 'helper',
      skillNames: ['chimera', 'code-review'],
    } as unknown as SubagentConfig;
    const report = await resolveHostSubagentSkillResolution(
      deps(),
      {},
      pinned,
      [],
      'Write a docker compose file',
    );
    expect(report.selected).toEqual(['chimera', 'code-review']);
  });
});
