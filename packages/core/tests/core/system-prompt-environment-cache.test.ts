import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';

describe('system prompt environment cache', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-env-cache-'));
  });

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('evicts least-recently-used entries across changing models', async () => {
    const builder = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    for (let index = 0; index < 20; index += 1) {
      await builder.build({
        cwd: projectRoot,
        projectRoot,
        tools: [],
        model: `model-${index}`,
      });
    }

    const cache = (
      builder as unknown as {
        envCacheByRoot: Map<string, string>;
      }
    ).envCacheByRoot;
    expect(cache.size).toBe(16);
    expect([...cache.keys()].some((key) => key.includes('model-0'))).toBe(false);
    expect([...cache.keys()].some((key) => key.includes('model-19'))).toBe(true);
  });
});
