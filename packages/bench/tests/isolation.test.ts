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
