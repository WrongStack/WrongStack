import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBenchConfig, parseBenchConfig } from '../src/config.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cfg-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('parseBenchConfig structural errors', () => {
  it('rejects a non-object root', () => {
    expect(() => parseBenchConfig(null)).toThrow(/must be a JSON object/);
    expect(() => parseBenchConfig('nope')).toThrow(/must be a JSON object/);
  });

  it('rejects a non-object cell entry', () => {
    expect(() => parseBenchConfig({ cells: [42] })).toThrow(/cells\[0\] must be an object/);
  });
});

describe('loadBenchConfig', () => {
  it('loads and parses a valid config file', async () => {
    const file = path.join(dir, 'bench.config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        cells: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
        maxIterations: 10,
      }),
    );
    const cfg = await loadBenchConfig(file);
    expect(cfg.cells[0]!.label).toBe('anthropic/claude-opus-4-8');
    expect(cfg.maxIterations).toBe(10);
    expect(cfg.concurrency).toBe(4); // default
  });

  it('throws a readable error when the file is missing', async () => {
    await expect(loadBenchConfig(path.join(dir, 'nope.json'))).rejects.toThrow(
      /cannot read bench config/,
    );
  });

  it('throws a readable error for invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ not valid json');
    await expect(loadBenchConfig(file)).rejects.toThrow(/is not valid JSON/);
  });
});
