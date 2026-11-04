/**
 * Regression: update() grouped manifest entries by source and reinstalled the
 * repo as `user/repo@ref` without a selector, so after `install('user/repo#first')`
 * every sibling skill in the repo — prompt content the user never chose — was
 * installed and reported as "updated". update() now restricts the reinstall
 * to the skills already installed from that source.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetcherMocks = vi.hoisted(() => ({ downloadGitHubTarball: vi.fn() }));

vi.mock('../../src/skills/github-fetcher.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, downloadGitHubTarball: fetcherMocks.downloadGitHubTarball };
});

import { SkillInstaller } from '../../src/skills/skill-installer.js';

let tmpRoot: string;
let projectSkillsDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-update-selection-'));
  projectSkillsDir = path.join(tmpRoot, 'project-skills');
  fetcherMocks.downloadGitHubTarball.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Every download gets a fresh copy (the installer removes the temp dir). */
async function serveRepo(names: string[]): Promise<void> {
  fetcherMocks.downloadGitHubTarball.mockImplementation(async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'repo-'));
    for (const name of names) {
      const skillDir = path.join(dir, 'skills', name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}-desc\n---\n# ${name}`,
      );
    }
    return { tempDir: dir };
  });
}

function makeInstaller(): SkillInstaller {
  return new SkillInstaller({
    manifestPath: path.join(tmpRoot, 'manifest.json'),
    projectSkillsDir,
    globalSkillsDir: path.join(tmpRoot, 'global-skills'),
    projectHash: 'hash-1',
  });
}

const installedNames = async (installer: SkillInstaller) =>
  (await installer.listInstalled()).map((entry) => entry.name).sort();

describe('SkillInstaller.update keeps the selection', () => {
  it.each([undefined, 'user/repo@v2'])(
    'update(%s) does not add unselected siblings',
    async (arg) => {
      await serveRepo(['first', 'second', 'third']);
      const installer = makeInstaller();
      await installer.install('user/repo#first');

      const result = await installer.update(arg);

      expect(result.updated.map((entry) => entry.name)).toEqual(['first']);
      expect(await installedNames(installer)).toEqual(['first']);
      expect(await fs.readdir(projectSkillsDir)).toEqual(['first']);
    },
  );

  it('updates every skill of a whole-repo install', async () => {
    await serveRepo(['first', 'second', 'third']);
    const installer = makeInstaller();
    await installer.install('user/repo');

    const result = await installer.update();

    expect(result.updated.map((entry) => entry.name).sort()).toEqual(['first', 'second', 'third']);
  });

  it('updates two separate selections from one repo and never the third skill', async () => {
    await serveRepo(['first', 'second', 'third']);
    const installer = makeInstaller();
    await installer.install('user/repo#first');
    await installer.install('user/repo#second');

    const result = await installer.update();

    expect(result.updated.map((entry) => entry.name).sort()).toEqual(['first', 'second']);
    expect(await installedNames(installer)).toEqual(['first', 'second']);
  });

  it('records an error instead of installing siblings when the selection vanished upstream', async () => {
    await serveRepo(['first', 'second']);
    const installer = makeInstaller();
    await installer.install('user/repo#first');
    await serveRepo(['second', 'third']);

    const result = await installer.update();

    expect(result.updated).toEqual([]);
    expect(result.errors.map((error) => error.name)).toEqual(['first']);
    expect(await installedNames(installer)).toEqual(['first']);
  });

  it('honors an explicit #skillName fragment when updating a multi-skill repo', async () => {
    await serveRepo(['first', 'second']);
    const installer = makeInstaller();
    await installer.install('user/repo');

    const result = await installer.update('user/repo@v2#first');

    expect(result.updated.map((entry) => entry.name)).toEqual(['first']);
  });
});
