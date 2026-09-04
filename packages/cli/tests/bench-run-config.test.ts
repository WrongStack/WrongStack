import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBenchRunConfig } from '../src/subcommands/handlers/bench-run-config.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('resolveBenchRunConfig', () => {
  it('does not require bench.config.json when a saved provider/model exists', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-run-config-'));
    tempDirs.push(cwd);

    const config = await resolveBenchRunConfig({
      suiteId: 'core',
      cwd,
      flags: {},
      savedProvider: 'anthropic',
      savedModel: 'claude-sonnet-4-6',
    });

    expect(config.maxIterations).toBe(40);
    expect(config.timeoutMs).toBe(600_000);
    expect(config.cells).toEqual([
      {
        label: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    ]);
  });

  it('treats a missing default bench.config.json as optional, not fatal', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-run-config-'));
    tempDirs.push(cwd);

    await expect(
      resolveBenchRunConfig({
        suiteId: 'smoke',
        cwd,
        flags: { models: 'bench.config.json' },
      }),
    ).rejects.toThrow(/No model cells/);
  });

  it('still errors when an explicit custom --models file is missing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-run-config-'));
    tempDirs.push(cwd);

    await expect(
      resolveBenchRunConfig({
        suiteId: 'smoke',
        cwd,
        flags: { models: 'missing-matrix.json' },
        savedProvider: 'anthropic',
        savedModel: 'claude-sonnet-4-6',
      }),
    ).rejects.toThrow(/cannot read bench config/);
  });

  it('prefers --cell over a missing config file', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-run-config-'));
    tempDirs.push(cwd);

    const config = await resolveBenchRunConfig({
      suiteId: 'smoke',
      cwd,
      flags: { cell: 'openai/gpt-5.4' },
    });
    expect(config.cells[0]?.model).toBe('gpt-5.4');
  });
});
