/**
 * `typesafe.logContent` must take effect for judges resolved after it changes.
 *
 * Judges are memoised per (endpoint, model, credential, ...) so features share
 * one breaker. The memo key once ignored `logContent`, so after
 * `/jev logcontent off` every later judge still got the client that was built
 * with content logging ON and kept writing full request/response payloads to
 * disk (and the reverse for turning it on).
 *
 * Own file: `recordJevActivity` memoises the log path on first write.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types/config/root';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DefaultConfigStore } from '../src/storage/config-store.js';
import { resetTypeSafeJudgesForTests, resolveTypeSafeJudge } from '../src/typesafe/judgments.js';
import { resetSharedTypeSafeRestGatesForTests } from '../src/typesafe/rest.js';

let dir = '';
const logFile = () => join(dir, `jev-${process.pid}.jsonl`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-logcontent-memo-'));
  process.env['WRONGSTACK_JEV_LOG_DIR'] = dir;
});

afterAll(async () => {
  delete process.env['WRONGSTACK_JEV_LOG_DIR'];
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  resetTypeSafeJudgesForTests();
  resetSharedTypeSafeRestGatesForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function records(count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const lines = await readFile(logFile(), 'utf8').then(
      (text) => text.split('\n').filter(Boolean),
      () => [],
    );
    if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Jev log did not reach ${count} records`);
}

const config = (logContent: boolean): Config =>
  ({ version: 1, typesafe: { enabled: true, apiKey: 'memo-key-12345678', logContent } }) as Config;

const ask = (marker: string) => ({
  activityFeature: 'brain',
  state: { marker },
  questions: { check: { type: 'noul' as const, instructions: 'Is it fine?' } },
});

const stubFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: { check: { type: 'noul', noul: 1 } },
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        ),
    ),
  );

describe('resolveTypeSafeJudge memo and logContent', () => {
  it('stops recording content for judges resolved after logContent is turned off', async () => {
    stubFetch();
    const store = new DefaultConfigStore(config(true));

    // Control: content logging on records the request payload.
    await resolveTypeSafeJudge({ config: store.get(), feature: 'brain' })!.client.systemOne(
      ask('marker-while-on'),
    );
    const first = await records(1);
    expect(first[0]?.['request']).toBeDefined();

    store.update({ typesafe: { ...store.get().typesafe, logContent: false } });
    await resolveTypeSafeJudge({ config: store.get(), feature: 'brain' })!.client.systemOne(
      ask('marker-after-off'),
    );
    const all = await records(2);
    expect(JSON.stringify(all[1])).not.toContain('marker-after-off');
    expect(all[1]?.['request']).toBeUndefined();
  });

  it('starts recording content for judges resolved after logContent is turned on', async () => {
    stubFetch();
    const store = new DefaultConfigStore(config(false));
    await resolveTypeSafeJudge({ config: store.get(), feature: 'brain' })!.client.systemOne(
      ask('marker-while-off'),
    );
    const before = await records(3);
    expect(before[2]?.['request']).toBeUndefined();

    store.update({ typesafe: { ...store.get().typesafe, logContent: true } });
    await resolveTypeSafeJudge({ config: store.get(), feature: 'brain' })!.client.systemOne(
      ask('marker-after-on'),
    );
    const all = await records(4);
    expect(JSON.stringify(all[3])).toContain('marker-after-on');
  });

  it('still shares one client while logContent is unchanged', () => {
    const store = new DefaultConfigStore(config(true));
    const a = resolveTypeSafeJudge({ config: store.get(), feature: 'brain' });
    const b = resolveTypeSafeJudge({ config: store.get(), feature: 'memoryTriage' });
    expect(a?.client).toBe(b?.client);
  });
});
