import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistServerConfig, serverConfigPath } from '../../src/config-persist.js';

const realHome = process.env['WRONGSTACK_HOME'];
let home: string;
let project: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-cfg-'));
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-proj-'));
  process.env['WRONGSTACK_HOME'] = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = realHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

const read = async (): Promise<Record<string, any>> =>
  JSON.parse(await fs.readFile(serverConfigPath(project), 'utf8')) as Record<string, any>;

const entry = { command: 'tsls', args: ['--stdio'], languages: ['typescript'] };

describe('persistServerConfig', () => {
  it('writes to the project-private config, never the repo-committed one', () => {
    const target = serverConfigPath(project);
    expect(target.startsWith(home)).toBe(true);
    expect(target.endsWith('config.local.json')).toBe(true);
    // The in-project layer denies `extensions` outright, so writing there
    // would be silently stripped on load.
    expect(target).not.toContain(path.join(project, '.wrongstack'));
  });

  it('creates the file with the plugin section', async () => {
    await persistServerConfig(project, 'typescript', entry);
    const cfg = await read();
    expect(cfg.extensions['@wrongstack/plug-lsp'].servers.typescript).toMatchObject(entry);
    expect(cfg.version).toBe(1);
  });

  it('preserves unrelated keys — this file also holds credentials', async () => {
    const target = serverConfigPath(project);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, apiKey: 'secret', extensions: { other: { keep: true } } }),
    );
    await persistServerConfig(project, 'typescript', entry);
    const cfg = await read();
    expect(cfg.apiKey).toBe('secret');
    expect(cfg.extensions.other).toEqual({ keep: true });
    expect(cfg.extensions['@wrongstack/plug-lsp'].servers.typescript.command).toBe('tsls');
  });

  it('merges into an existing entry rather than replacing it', async () => {
    await persistServerConfig(project, 'typescript', entry);
    await persistServerConfig(project, 'typescript', { enabled: false });
    const saved = (await read()).extensions['@wrongstack/plug-lsp'].servers.typescript;
    expect(saved).toMatchObject({ command: 'tsls', enabled: false });
    expect(saved.languages).toEqual(['typescript']);
  });

  it('removes an entry when the patch is null, leaving siblings alone', async () => {
    await persistServerConfig(project, 'typescript', entry);
    await persistServerConfig(project, 'gopls', { command: 'gopls', languages: ['go'] });
    await persistServerConfig(project, 'typescript', null);
    const servers = (await read()).extensions['@wrongstack/plug-lsp'].servers;
    expect(servers.typescript).toBeUndefined();
    expect(servers.gopls.command).toBe('gopls');
  });

  it('stamps version 1 onto a file that has none', async () => {
    const target = serverConfigPath(project);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ apiKey: 'secret' }));
    await persistServerConfig(project, 'typescript', entry);
    expect((await read()).version).toBe(1);
  });

  it('refuses to start from scratch when the file is corrupt', async () => {
    const target = serverConfigPath(project);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '[1, 2, 3]');
    await expect(persistServerConfig(project, 'typescript', entry)).rejects.toThrow(
      'not a JSON object',
    );
  });

  it('leaves no temp file behind', async () => {
    await persistServerConfig(project, 'typescript', entry);
    const dir = path.dirname(serverConfigPath(project));
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('propagates a read failure that is not "file missing"', async () => {
    const target = serverConfigPath(project);
    // A directory where the config file should be: read fails with EISDIR on
    // POSIX and EISDIR/EPERM on Windows — never ENOENT, so it must not be
    // mistaken for "no config yet" and overwritten.
    await fs.mkdir(target, { recursive: true });
    await expect(persistServerConfig(project, 'typescript', entry)).rejects.toThrow();
  });
});
