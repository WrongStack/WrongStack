import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillGeneratorCommand } from '../src/skills-plugin-authoring.js';

describe('/skill-gen flag parsing boundaries', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-gen-flags-'));
    fakeHome = path.join(tmpRoot, 'wstack-home');
    projectRoot = path.join(tmpRoot, 'project');
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    prevHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function createLoader(): SkillLoader {
    return {
      listEntries: async () => [
        {
          name: 'deploy-guard',
          source: 'user',
          trigger: 'when deploying',
          path: path.join(fakeHome, 'profiles', 'default', 'skills', 'deploy-guard', 'SKILL.md'),
          scope: ['user'],
        },
      ],
      invalidateCache: () => {},
      find: async () => undefined,
      readBody: async () => '',
    } as unknown as SkillLoader;
  }

  it('does not treat --force or --global inside quoted or mid-prose prompts as CLI flags', async () => {
    const cmd = buildSkillGeneratorCommand(createLoader());
    const ctx = { projectRoot } as unknown as Context;

    const collision = await cmd.run(
      'from-prompt "# Deploy Guard\nNever run git push --force or npm i --global in CI."',
      ctx,
    );
    expect(collision?.message).toContain('collides with existing user skill "deploy-guard"');

    const safe = await cmd.run(
      'from-prompt "# Safe Release\nNever run git push --force or npm i --global in CI."',
      ctx,
    );
    expect(safe?.message).toContain('✓ Drafted safe-release');
    const projectFile = path.join(projectRoot, '.wrongstack', 'skills', 'safe-release', 'SKILL.md');
    const body = await fs.readFile(projectFile, 'utf8');
    expect(body).toContain('git push --force');
    expect(body).toContain('npm i --global');
  });

  it('honors outer CLI --global and --force around a quoted prompt while preserving inner flags', async () => {
    const cmd = buildSkillGeneratorCommand(createLoader());
    const ctx = { projectRoot } as unknown as Context;

    const res = await cmd.run(
      'from-prompt --global "# Deploy Guard\nNever run git push --force." --force',
      ctx,
    );
    expect(res?.message).toContain('✓ Drafted deploy-guard');
    const globalFile = path.join(
      fakeHome,
      'profiles',
      'default',
      'skills',
      'deploy-guard',
      'SKILL.md',
    );
    const body = await fs.readFile(globalFile, 'utf8');
    expect(body).toContain('git push --force');
  });

  it('skips --desc and --trigger flag values when extracting positional <name> in skeleton', async () => {
    const cmd = buildSkillGeneratorCommand(createLoader());
    const ctx = { projectRoot } as unknown as Context;

    const missingName = await cmd.run('skeleton --desc "Deploy helper" --trigger deploy,ci', ctx);
    expect(missingName?.message).toContain('Usage: /skill-gen skeleton <name>');

    const created = await cmd.run(
      'skeleton --desc "Deploy helper" --trigger deploy,ci release-pilot',
      ctx,
    );
    expect(created?.message).toContain('✓ Scaffolded release-pilot');
    const body = await fs.readFile(
      path.join(projectRoot, '.wrongstack', 'skills', 'release-pilot', 'SKILL.md'),
      'utf8',
    );
    expect(body).toContain('Deploy helper');
  });
});
