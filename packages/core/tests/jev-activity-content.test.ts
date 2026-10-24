/**
 * Full request/response records in the Jev activity log.
 *
 * Lives in its own file because `recordJevActivity` memoizes the log path on
 * the first write: one process, one log file, so every case here shares a
 * single temporary directory and asserts on its own line of it.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types/config/root';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jevActivitySnapshot, observeJevClient } from '../src/typesafe/activity.js';
import { jevSettingsSnapshot, validateJevSettingsPatch } from '../src/typesafe/settings.js';

const KEY = 'unit-test-account-credential';
const ANSWERED = {
  answers: {
    depth: {
      type: 'score' as const,
      score: 1,
      probabilities: { '0': 0.2, '1': 0.8 },
      confidence: 0.7,
      legend: { '0': 'Shallow', '1': 'Deep' },
    },
  },
  usage: { inputTokens: 12, outputTokens: 3 },
  model: 'jev-latest',
};
const stub = { open: false, systemOne: async () => ANSWERED };
const ask = (state: unknown) => ({
  activityFeature: 'memoryRecall',
  state,
  questions: {
    depth: {
      type: 'score' as const,
      instructions: 'How deep is the evidence?',
      criteria: ['Only a passing mention', 'Direct, detailed evidence'],
    },
  },
});

let dir = '';
const logFile = () => join(dir, `jev-${process.pid}.jsonl`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-content-'));
  process.env['WRONGSTACK_JEV_LOG_DIR'] = dir;
});

afterAll(async () => {
  delete process.env['WRONGSTACK_JEV_LOG_DIR'];
  await rm(dir, { recursive: true, force: true });
});

/** Wait for the log to hold `count` records rather than sleeping a fixed span. */
type LogRecord = Record<string, any>;

async function records(count: number): Promise<LogRecord[]> {
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

describe('Jev activity content records', () => {
  it('records what was asked and what came back, on disk only', async () => {
    // Off unless asked for: attribution only, no payload.
    await observeJevClient(stub, 'typesafe', 'jev').systemOne(ask({ note: 'plain-state' }));
    // On: the whole request and the whole response, key scrubbed.
    await observeJevClient(stub, 'typesafe', 'jev', { logContent: true, secrets: [KEY] }).systemOne(
      ask({ note: 'verbose-state', credential: KEY }),
    );
    // On, and it failed: the record says what and why, not just the category.
    await observeJevClient(
      {
        open: false,
        systemOne: async () => {
          throw new Error('Network error calling TypeSafe', { cause: new TypeError('ECONNRESET') });
        },
      },
      'typesafe',
      'jev',
      { logContent: true },
    )
      .systemOne(ask({ note: 'failed-state' }))
      .catch(() => undefined);

    const [plain, verbose, failed] = (await records(3)) as [LogRecord, LogRecord, LogRecord];

    expect(plain).toMatchObject({ feature: 'memoryRecall', outcome: 'answered' });
    expect(plain['request']).toBeUndefined();
    expect(plain['response']).toBeUndefined();

    expect(verbose['request']).toMatchObject({
      state: { note: 'verbose-state', credential: '[redacted]' },
      questions: { depth: { instructions: 'How deep is the evidence?' } },
    });
    expect(verbose['response']).toEqual(ANSWERED);

    expect(failed['error']).toMatchObject({
      name: 'Error',
      message: 'Network error calling TypeSafe',
      cause: { name: 'TypeError', message: 'ECONNRESET' },
    });

    const raw = await readFile(logFile(), 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).toContain('[redacted]');
  });

  it('keeps the live tail metadata-only whatever the log file holds', async () => {
    await records(3);
    const tail = JSON.stringify(jevActivitySnapshot().entries.slice(0, 3));
    expect(tail).not.toMatch(/verbose-state|failed-state|How deep is the evidence|ECONNRESET/);
  });

  it('caps one oversized payload instead of writing an unreadable line', async () => {
    await observeJevClient(stub, 'typesafe', 'jev', { logContent: true }).systemOne(
      ask({ blob: 'x'.repeat(300 * 1024) }),
    );
    const [oversized] = (await records(4)).slice(3) as [LogRecord];
    expect(String(oversized['request'])).toMatch(/^\[truncated: \d+ chars, limit \d+\]$/);
  });
});

describe('Jev content-logging setting', () => {
  it('reports the profile switch and validates the patch', () => {
    const off = { typesafe: { apiKey: 'k' } } as unknown as Config;
    expect(jevSettingsSnapshot(off).logContent).toBe(false);
    const on = { typesafe: { apiKey: 'k', logContent: true } } as unknown as Config;
    expect(jevSettingsSnapshot(on).logContent).toBe(true);
    expect(() => validateJevSettingsPatch({ logContent: 'yes' })).toThrow(/log content/);
    expect(validateJevSettingsPatch({ logContent: false })).toMatchObject({ logContent: false });
  });
});
