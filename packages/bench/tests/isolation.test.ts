import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupSandbox, createSandbox, prepareWorkdir } from '../src/isolation.js';

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-test-'));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('createSandbox', () => {
  it('creates the tree and seeds config.json', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 25, yolo: true });
    expect(sandbox.root).toBe(base);
    const cfg = JSON.parse(await fs.readFile(path.join(sandbox.homeDir, 'config.json'), 'utf8'));
    expect(cfg).toMatchObject({
      yolo: true,
      tools: { maxIterations: 25 },
      session: { auditLevel: 'standard' },
    });
    await expect(fs.stat(sandbox.workRoot)).resolves.toBeDefined();
  });

  it('copies host vault, providers, and models cache into the sandbox', async () => {
    const host = path.join(base, 'host-home');
    await fs.mkdir(path.join(host, 'profiles', 'default'), { recursive: true });
    await fs.mkdir(path.join(host, 'cache'), { recursive: true });
    await fs.writeFile(path.join(host, '.key'), 'vault-key', 'utf8');
    await fs.writeFile(
      path.join(host, 'config.json'),
      JSON.stringify({
        providers: { 'zai-coding-plan': { type: 'openai-compatible', apiKey: 'enc:v1:x' } },
        plugins: [{ id: 'noise' }],
        mcpServers: { skip: {} },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(host, 'profiles', 'default', 'config.json'),
      JSON.stringify({ providers: { 'zai-coding-plan': { type: 'openai-compatible' } } }),
      'utf8',
    );
    await fs.writeFile(path.join(host, 'cache', 'models.dev.json'), '{"ok":true}', 'utf8');

    const sandbox = await createSandbox({
      baseDir: path.join(base, 'sandbox'),
      maxIterations: 20,
      yolo: true,
      hostHomeDir: host,
    });
    const cfg = JSON.parse(await fs.readFile(path.join(sandbox.homeDir, 'config.json'), 'utf8'));
    expect(cfg.yolo).toBe(true);
    expect(cfg.tools.maxIterations).toBe(20);
    expect(cfg.providers['zai-coding-plan'].type).toBe('openai-compatible');
    expect(cfg.plugins).toBeUndefined();
    expect(cfg.mcpServers).toBeUndefined();
    expect(await fs.readFile(path.join(sandbox.homeDir, '.key'), 'utf8')).toBe('vault-key');
    const profile = JSON.parse(
      await fs.readFile(path.join(sandbox.homeDir, 'profiles', 'default', 'config.json'), 'utf8'),
    );
    expect(profile.providers['zai-coding-plan']).toBeDefined();
    expect(await fs.readFile(path.join(sandbox.homeDir, 'cache', 'models.dev.json'), 'utf8')).toBe(
      '{"ok":true}',
    );
  });

  it('defaults to an OS temp dir when no baseDir is given', async () => {
    const sandbox = await createSandbox({ maxIterations: 1, yolo: false });
    try {
      expect(sandbox.root).toContain('wstack-bench-');
    } finally {
      await fs.rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it('handles hostHome without profiles dir and profile without config.json', async () => {
    // Case 1: hostHome without profiles dir
    const host1 = path.join(base, 'host1');
    await fs.mkdir(host1, { recursive: true });
    await fs.writeFile(path.join(host1, 'config.json'), '{}', 'utf8');
    const sb1 = await createSandbox({
      baseDir: path.join(base, 'sb1'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host1,
    });
    expect(sb1.homeDir).toBeDefined();

    // Case 2: profile dir exists without config.json (hits writeOverlayConfig !required)
    const host2 = path.join(base, 'host2');
    await fs.mkdir(path.join(host2, 'profiles', 'empty-prof'), { recursive: true });
    await fs.writeFile(
      path.join(host2, 'config.json'),
      JSON.stringify({ activeProfile: 'empty-prof' }),
      'utf8',
    );
    const sb2 = await createSandbox({
      baseDir: path.join(base, 'sb2'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host2,
    });
    expect(sb2.homeDir).toBeDefined();

    // Case 3: hostHome with missing config.json (required: true fails read)
    const host3 = path.join(base, 'host3');
    await fs.mkdir(host3, { recursive: true });
    const sb3 = await createSandbox({
      baseDir: path.join(base, 'sb3'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host3,
    });
    expect(sb3.homeDir).toBeDefined();

    // Case 4: hostHome with non-object config.json (primitive) and non-record tools/session
    const host4 = path.join(base, 'host4');
    await fs.mkdir(host4, { recursive: true });
    await fs.writeFile(host4 + '/config.json', '"just a string"', 'utf8');
    const sb4 = await createSandbox({
      baseDir: path.join(base, 'sb4'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host4,
    });
    expect(sb4.homeDir).toBeDefined();

    const host5 = path.join(base, 'host5');
    await fs.mkdir(host5, { recursive: true });
    await fs.writeFile(
      host5 + '/config.json',
      JSON.stringify({ tools: 'bad', session: 'bad' }),
      'utf8',
    );
    const sb5 = await createSandbox({
      baseDir: path.join(base, 'sb5'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host5,
    });
    expect(sb5.homeDir).toBeDefined();

    const host6 = path.join(base, 'host6');
    await fs.mkdir(host6, { recursive: true });
    await fs.writeFile(
      host6 + '/config.json',
      JSON.stringify({ tools: { customProp: 1 }, session: { customProp: 2 } }),
      'utf8',
    );
    const sb6 = await createSandbox({
      baseDir: path.join(base, 'sb6'),
      maxIterations: 1,
      yolo: false,
      hostHomeDir: host6,
    });
    expect(sb6.homeDir).toBeDefined();
  });
});

describe('prepareWorkdir', () => {
  async function template(): Promise<string> {
    const tdir = path.join(base, 'template');
    await fs.mkdir(path.join(tdir, '.meta'), { recursive: true });
    await fs.writeFile(path.join(tdir, 'solution.py'), 'pass');
    await fs.writeFile(path.join(tdir, '.meta', 'example.py'), 'reference');
    return tdir;
  }

  it('copies the whole template when no exclude is given', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    const dest = await prepareWorkdir(sandbox, await template(), 'polyglot/python/x', 'opus-4.8');
    await expect(fs.stat(path.join(dest, 'solution.py'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(dest, '.meta', 'example.py'))).resolves.toBeDefined();
  });

  it('drops excluded segments (e.g. .meta) from the copy', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    const dest = await prepareWorkdir(sandbox, await template(), 'task/id', 'cell', ['.meta']);
    await expect(fs.stat(path.join(dest, 'solution.py'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(dest, '.meta'))).rejects.toThrow(); // excluded
  });

  it('produces a fresh copy on a second prepare (no stale edits)', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    const t = await template();
    const dest1 = await prepareWorkdir(sandbox, t, 'task/id', 'cell');
    await fs.writeFile(path.join(dest1, 'solution.py'), 'EDITED');
    const dest2 = await prepareWorkdir(sandbox, t, 'task/id', 'cell');
    expect(dest2).toBe(dest1); // same deterministic name
    expect(await fs.readFile(path.join(dest2, 'solution.py'), 'utf8')).toBe('pass'); // reset
  });

  it('slugifies awkward labels and ids into a safe dir name', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    const dest = await prepareWorkdir(sandbox, await template(), 'Weird/ID With Spaces!', '@@@');
    // '@@@' slugifies to the fallback 'x'; the awkward id becomes a dashed slug.
    expect(path.basename(dest)).toMatch(/^x__weird-id-with-spaces$/);
  });
});

describe('cleanupSandbox', () => {
  it('removes the whole sandbox tree', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    await cleanupSandbox(sandbox);
    await expect(fs.stat(sandbox.root)).rejects.toThrow();
  });

  it('never throws when the tree is already gone', async () => {
    const sandbox = await createSandbox({ baseDir: base, maxIterations: 1, yolo: false });
    await fs.rm(sandbox.root, { recursive: true, force: true });
    await expect(cleanupSandbox(sandbox)).resolves.toBeUndefined();
  });
});
