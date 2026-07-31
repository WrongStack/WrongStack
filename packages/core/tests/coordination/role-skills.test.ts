import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assignSkillsToAgents,
  BUNDLED_AGENT_SKILLS,
  ROLE_SKILL_SETS,
} from '../../src/coordination/agents/role-skills.js';
import type { AgentDefinition } from '../../src/coordination/agents/types.js';
import { DefaultSkillLoader } from '../../src/execution/skill-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');

/** Every skill name referenced across all curated role sets. */
const roleSkillNames = new Set<string>(Object.values(ROLE_SKILL_SETS).flat());

/** A loader that sees ONLY the bundled layer (no project/user/foreign/claude). */
function bundledOnlyLoader(): DefaultSkillLoader {
  const paths = resolveWstackPaths({
    projectRoot: path.join(bundledDir, '__no_project__'),
    globalRoot: path.join(bundledDir, '__no_global__'),
    userHome: path.join(bundledDir, '__no_home__'),
  });
  return new DefaultSkillLoader({
    paths,
    bundledDir,
    readClaudeSkills: false,
    foreignSources: false,
  });
}

describe('role-skills integrity', () => {
  it('T7: every BUNDLED_AGENT_SKILLS name resolves to a real bundled skill', async () => {
    const manifests = await bundledOnlyLoader().list();
    const bundledNames = new Set(
      manifests.filter((m) => m.source === 'bundled').map((m) => m.name),
    );
    const missing = BUNDLED_AGENT_SKILLS.filter((name) => !bundledNames.has(name));
    // A missing entry means a role references a skill that does not ship in
    // packages/core/skills — the worker would silently fall back to persona only.
    expect(missing).toEqual([]);
  });

  it('T7: every ROLE_SKILL_SETS name is a declared bundled skill that resolves', async () => {
    // Role sets may only draw from the curated BUNDLED_AGENT_SKILLS list…
    const declared = new Set<string>(BUNDLED_AGENT_SKILLS);
    const undeclared = [...roleSkillNames].filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
    // …and each one must actually resolve through the loader.
    const loader = bundledOnlyLoader();
    const missing: string[] = [];
    for (const name of roleSkillNames) {
      if (!(await loader.find(name))) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('assignSkillsToAgents throws for a role with no curated skill set', () => {
    const bogus = [
      { config: { role: 'no-such-role', name: 'Bogus' } },
    ] as unknown as AgentDefinition[];
    expect(() => assignSkillsToAgents(bogus)).toThrow(/Missing curated skill set/);
  });

  it('assignSkillsToAgents attaches a fresh, mutation-safe skill array', () => {
    const defs = [
      { config: { role: 'reviewer', name: 'Reviewer' } },
    ] as unknown as AgentDefinition[];
    const assigned = assignSkillsToAgents(defs);
    const expected = [...ROLE_SKILL_SETS.reviewer];
    expect(assigned[0]?.config.skillNames).toEqual(expected);
    // Mutating the assigned array must not corrupt the shared catalog set.
    assigned[0]?.config.skillNames?.push('hacked');
    expect([...ROLE_SKILL_SETS.reviewer]).toEqual(expected);
  });
});
