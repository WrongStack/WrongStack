import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths, stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildProfileCommand } from '../src/slash-commands/profile.js';

describe('/profile', () => {
  let tmp: string;
  let paths: ReturnType<typeof resolveWstackPaths>;
  let update: ReturnType<typeof vi.fn>;
  let messages: string[];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-profile-command-'));
    const globalRoot = path.join(tmp, '.wrongstack');
    await fs.mkdir(path.join(globalRoot, 'profiles', 'default'), { recursive: true });
    await fs.writeFile(
      path.join(globalRoot, 'config.json'),
      JSON.stringify({ version: 1, activeProfile: 'default' }),
    );
    await fs.writeFile(
      path.join(globalRoot, 'profiles', 'default', 'config.json'),
      JSON.stringify({ provider: 'anthropic', model: 'claude' }),
    );
    paths = resolveWstackPaths({ projectRoot: path.join(tmp, 'project'), globalRoot });
    update = vi.fn();
    messages = [];
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function command() {
    return buildProfileCommand({
      paths,
      configStore: {
        get: () => ({ activeProfile: 'default' }),
        update,
      },
      renderer: {
        write: (message: string) => messages.push(message),
        writeWarning: (message: string) => messages.push(message),
      },
    } as never as SlashCommandContext);
  }

  it('copies the complete profile tree, not only config.json', async () => {
    await fs.writeFile(path.join(paths.profileDir, 'memory.md'), 'remember this');
    await fs.mkdir(path.join(paths.profileDir, 'skills', 'demo'), { recursive: true });
    await fs.writeFile(path.join(paths.profileDir, 'skills', 'demo', 'SKILL.md'), '# demo');

    const result = await command().run('copy work');
    const workDir = path.join(paths.profilesDir, 'work');

    expect(stripAnsi(result?.message ?? '')).toContain('Copied profile');
    expect(await fs.readFile(path.join(workDir, 'memory.md'), 'utf8')).toBe('remember this');
    expect(await fs.readFile(path.join(workDir, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(
      '# demo',
    );
  });

  it('switches only the bootstrap and exits for a consistent restart', async () => {
    const workDir = path.join(paths.profilesDir, 'work');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt' }),
    );

    const result = await command().run('switch work');
    const bootstrap = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8'));

    expect(bootstrap).toEqual({ version: 1, activeProfile: 'work' });
    expect(update).not.toHaveBeenCalled();
    expect(result?.exit).toBe(true);
    expect(stripAnsi(result?.message ?? '')).toContain('restart WrongStack');
  });
});
