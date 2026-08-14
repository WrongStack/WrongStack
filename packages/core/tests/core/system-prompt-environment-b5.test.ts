import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';

/**
 * B5 regression: the environment cache key omitted `today`, so in a
 * long-lived process (daemon / eternal autonomy) the cached environment
 * block kept yesterday's date after midnight — the stale "Today's date"
 * silently misled the agent. The key now includes `today` (and `modeId`)
 * so the cache invalidates on date rollover.
 */
describe('system prompt environment cache — date rollover (B5)', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-env-b5-'));
  });

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('produces different cached output when todayIso changes (date rollover)', async () => {
    const ctx = { cwd: projectRoot, projectRoot, tools: [] } as never;

    // Day 1
    const builderDay1 = new DefaultSystemPromptBuilder({ todayIso: '2026-08-13' });
    const blocksDay1 = await builderDay1.build(ctx);
    const textDay1 = blocksDay1.map((b) => b.text).join('\n');
    expect(textDay1).toContain("Today's date: 2026-08-13");

    // Day 2 — same builder cache shape, different date
    const builderDay2 = new DefaultSystemPromptBuilder({ todayIso: '2026-08-14' });
    const blocksDay2 = await builderDay2.build(ctx);
    const textDay2 = blocksDay2.map((b) => b.text).join('\n');
    expect(textDay2).toContain("Today's date: 2026-08-14");
    expect(textDay2).not.toContain("Today's date: 2026-08-13");
  });

  it('serves cached output when todayIso is unchanged across builds', async () => {
    const builder = new DefaultSystemPromptBuilder({ todayIso: '2026-08-13' });
    const ctx = { cwd: projectRoot, projectRoot, tools: [] } as never;

    const blocks1 = await builder.build(ctx);
    const blocks2 = await builder.build(ctx);

    // Same date + same context → identical block count (cache served).
    expect(blocks2.length).toBe(blocks1.length);
    const text1 = blocks1.map((b) => b.text).join('\n');
    const text2 = blocks2.map((b) => b.text).join('\n');
    expect(text2).toBe(text1);
  });

  it('includes today in the cache key so different dates occupy separate slots', async () => {
    const ctx = { cwd: projectRoot, projectRoot, tools: [] } as never;

    // Override todayIso via the builder's env state by building with
    // different dates. The cache is keyed by the resolved `today`, so
    // two different dates should produce two different cache entries.
    const b1 = new DefaultSystemPromptBuilder({ todayIso: '2026-01-01' });
    await b1.build(ctx);
    const cache1 = (b1 as unknown as { envCacheByRoot: Map<string, string> }).envCacheByRoot;

    const b2 = new DefaultSystemPromptBuilder({ todayIso: '2026-01-02' });
    await b2.build(ctx);
    const cache2 = (b2 as unknown as { envCacheByRoot: Map<string, string> }).envCacheByRoot;

    // Each builder's cache should contain a key with its respective date.
    expect([...cache1.keys()].some((k) => k.includes('2026-01-01'))).toBe(true);
    expect([...cache2.keys()].some((k) => k.includes('2026-01-02'))).toBe(true);
  });
});
