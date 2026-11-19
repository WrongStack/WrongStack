import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { RegistrySearchOptions, SkillRegistryAdapter } from '@wrongstack/core/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillImportCommand, buildSkillSearchCommand } from '../src/skills-plugin-registry.js';

describe('skills registry slash commands flag and pagination parsing', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-registry-flags-'));
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

  it('rejects non-positive, fractional, non-numeric, and missing --page/--pageSize values before calling adapters', async () => {
    const calls: Array<{ query: string; opts: RegistrySearchOptions }> = [];
    const adapter: SkillRegistryAdapter = {
      id: 'stub-reg',
      displayName: 'Stub registry',
      async search(query, opts) {
        calls.push({ query, opts: opts ?? {} });
        return { adapterId: 'stub-reg', results: [], hasMore: false };
      },
      resolveInstallRef(id: string) {
        return id;
      },
    };

    const cmd = buildSkillSearchCommand(undefined, [adapter]);
    const ctx = { projectRoot } as unknown as Context;

    for (const bad of [
      'react --page abc',
      'react --page 0',
      'react --page -2',
      'react --pageSize 1.5',
      'react --page',
      'react --page=',
      'react --pageSize=',
    ]) {
      const res = await cmd.run(bad, ctx);
      expect(res?.message).toContain('must be positive integers');
    }
    expect(calls).toHaveLength(0);
  });

  it('supports --page=N / --pageSize=N and preserves quoted query tokens starting with --', async () => {
    const calls: Array<{ query: string; opts: RegistrySearchOptions }> = [];
    const adapter: SkillRegistryAdapter = {
      id: 'stub-reg',
      displayName: 'Stub registry',
      async search(query, opts) {
        calls.push({ query, opts: opts ?? {} });
        return { adapterId: 'stub-reg', results: [], hasMore: false };
      },
      resolveInstallRef(id: string) {
        return id;
      },
    };

    const cmd = buildSkillSearchCommand(undefined, [adapter]);
    const ctx = { projectRoot } as unknown as Context;

    await cmd.run('--page=3 --pageSize=10 "--force"', ctx);
    expect(calls).toEqual([{ query: '--force', opts: { page: 3, pageSize: 10 } }]);
  });

  it('preserves quoted spaced paths and parses --from=<tool> / missing --from arguments in /skill-import', async () => {
    const spacedDir = path.join(tmpRoot, 'my custom skills');
    await fs.mkdir(path.join(spacedDir, 'alpha-skill'), { recursive: true });
    await fs.writeFile(
      path.join(spacedDir, 'alpha-skill', 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Alpha skill\n---\n# Alpha\nBody\n',
      'utf8',
    );
    await fs.mkdir(path.join(projectRoot, '.cursor', 'skills'), { recursive: true });

    const cmd = buildSkillImportCommand(undefined);
    const ctx = { projectRoot } as unknown as Context;

    const fromEq = await cmd.run('--from=cursor', ctx);
    expect(fromEq?.message).toContain('No valid skills found');

    const badTool = await cmd.run('--from=unknown-tool', ctx);
    expect(badTool?.message).toContain('Unknown tool "unknown-tool"');

    for (const incomplete of ['--from', '--from=', '--from --global', '--from --link']) {
      const res = await cmd.run(incomplete, ctx);
      expect(res?.message).toContain('Usage: /skill-import');
    }

    const okImport = await cmd.run(`"${spacedDir}"`, ctx);
    expect(okImport?.message).toContain('Imported 1 skill');
  });
});
