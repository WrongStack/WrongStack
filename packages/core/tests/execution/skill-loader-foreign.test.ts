import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

/**
 * Faz 6: foreign (non-claude) coding-agent skill dirs — codex/cursor/agents/qwen/
 * trae/… are scanned natively (source: 'foreign' + originTool), restricted by
 * `config.skills.foreignSources`. Every tool uses the standard `skills` subdir
 * (aligned with the skills.sh / antfu-skills-cli / vercel-labs ecosystem as of
 * 2026-07; Cursor previously used `skills-cursor`, which was WrongStack-only
 * and meant real Cursor skills were never discovered).
 */
let tmp: string;
let projectRoot: string;
let userHome: string;

const fm = (name: string, desc = 'd') => `---\nname: ${name}\ndescription: ${desc}\n---\nbody`;

async function writeSkill(base: string, name: string) {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), fm(name));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-foreign-'));
  projectRoot = path.join(tmp, 'proj');
  userHome = path.join(tmp, 'home');
  await fs.mkdir(projectRoot, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mkLoader(opts: { readClaudeSkills?: false; foreignSources?: boolean | string[] } = {}) {
  const paths = resolveWstackPaths({ projectRoot, userHome });
  return new DefaultSkillLoader({ paths, readClaudeSkills: false, ...opts });
}

describe('DefaultSkillLoader — foreign (non-claude) agent dirs', () => {
  it('discovers codex skills and cursor skills (standard subdir) with originTool', async () => {
    await writeSkill(path.join(userHome, '.codex', 'skills'), 'codex-skill');
    await writeSkill(path.join(userHome, '.cursor', 'skills'), 'cursor-skill');
    const byName = new Map((await mkLoader().list()).map((s) => [s.name, s]));
    expect(byName.get('codex-skill')?.source).toBe('foreign');
    expect(byName.get('codex-skill')?.originTool).toBe('codex');
    expect(byName.get('cursor-skill')?.source).toBe('foreign');
    expect(byName.get('cursor-skill')?.originTool).toBe('cursor');
  });

  it('scans project-level foreign dirs too', async () => {
    await writeSkill(path.join(projectRoot, '.trae', 'skills'), 'trae-proj');
    const found = (await mkLoader().list()).find((s) => s.name === 'trae-proj');
    expect(found?.source).toBe('foreign');
    expect(found?.originTool).toBe('trae');
  });

  it('foreignSources:false disables all foreign tool scanning', async () => {
    await writeSkill(path.join(userHome, '.codex', 'skills'), 'codex-skill');
    expect((await mkLoader({ foreignSources: false }).list()).map((s) => s.name)).not.toContain(
      'codex-skill',
    );
  });

  it('foreignSources:[ids] restricts to those tools', async () => {
    await writeSkill(path.join(userHome, '.codex', 'skills'), 'codex-skill');
    await writeSkill(path.join(userHome, '.cursor', 'skills'), 'cursor-skill');
    const names = (await mkLoader({ foreignSources: ['cursor'] }).list()).map((s) => s.name);
    expect(names).toContain('cursor-skill');
    expect(names).not.toContain('codex-skill');
  });

  it('the legacy non-standard cursor subdir (skills-cursor) is NOT scanned', async () => {
    // Cursor now uses the standard `skills` subdir like every other agent.
    // A skill placed under the old WrongStack-only `skills-cursor` path must
    // not be discovered — otherwise users would think Cursor integration works
    // while it reads the wrong dir.
    await fs.mkdir(path.join(userHome, '.cursor', 'skills-cursor', 'legacy-cursor'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(userHome, '.cursor', 'skills-cursor', 'legacy-cursor', 'SKILL.md'),
      fm('legacy-cursor'),
    );
    expect((await mkLoader().list()).map((s) => s.name)).not.toContain('legacy-cursor');
  });
});
