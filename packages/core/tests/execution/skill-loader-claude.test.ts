import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

/**
 * Faz 1: foreign coding-agent skill directories (`<project>/.claude/skills` and
 * `~/.claude/skills`) are discovered natively, tagged with a distinct `source`,
 * shadowed by same-named `.wrongstack` skills, opt-out via `readClaudeSkills`,
 * and supplemented by `config.skills.extraDirs`.
 */
let tmp: string;
let projectRoot: string;
let userHome: string;

const fm = (name: string, desc: string, body = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

async function writeSkill(base: string, name: string, body = '') {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), fm(name, `skill ${name}`, body));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-claude-'));
  projectRoot = path.join(tmp, 'proj');
  userHome = path.join(tmp, 'home');
  await fs.mkdir(projectRoot, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('DefaultSkillLoader — foreign (.claude) + extra dirs', () => {
  it('discovers project + user .claude skills with distinct sources', async () => {
    await writeSkill(path.join(projectRoot, '.wrongstack', 'skills'), 'ws-proj');
    await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'claude-proj');
    await writeSkill(
      path.join(userHome, '.wrongstack', 'profiles', 'default', 'skills'),
      'ws-user',
    );
    await writeSkill(path.join(userHome, '.claude', 'skills'), 'claude-user');

    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths });
    const byName = new Map((await loader.list()).map((s) => [s.name, s.source]));

    expect(byName.get('ws-proj')).toBe('project');
    expect(byName.get('claude-proj')).toBe('claude-project');
    expect(byName.get('ws-user')).toBe('user');
    expect(byName.get('claude-user')).toBe('claude-user');
  });

  it('shadows a .claude skill with a same-named .wrongstack skill (first-seen wins)', async () => {
    await writeSkill(path.join(projectRoot, '.wrongstack', 'skills'), 'shared');
    await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'shared');

    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths });
    const shared = (await loader.list()).find((s) => s.name === 'shared');
    expect(shared).toBeDefined();
    expect(shared?.source).toBe('project');
  });

  it('honors readClaudeSkills:false — excludes both .claude layers', async () => {
    await writeSkill(path.join(projectRoot, '.wrongstack', 'skills'), 'ws-proj');
    await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'claude-proj');
    await writeSkill(path.join(userHome, '.claude', 'skills'), 'claude-user');

    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths, readClaudeSkills: false });
    const names = (await loader.list()).map((s) => s.name);
    expect(names).toContain('ws-proj');
    expect(names).not.toContain('claude-proj');
    expect(names).not.toContain('claude-user');
  });

  it('defaults readClaudeSkills to true when undefined', async () => {
    await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'claude-proj');
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths }); // readClaudeSkills undefined → true
    expect((await loader.list()).map((s) => s.name)).toContain('claude-proj');
  });

  it('scans extraDirs as the extra source', async () => {
    const extra = path.join(tmp, 'extra-skills');
    await writeSkill(extra, 'extra-one');
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths, extraDirs: [extra] });
    const found = (await loader.list()).find((s) => s.name === 'extra-one');
    expect(found?.source).toBe('extra');
  });

  it('reads the body of a foreign skill', async () => {
    await writeSkill(
      path.join(projectRoot, '.claude', 'skills'),
      'foreign',
      'Foreign body content',
    );
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const loader = new DefaultSkillLoader({ paths });
    expect(await loader.readBody('foreign')).toContain('Foreign body content');
  });
});
