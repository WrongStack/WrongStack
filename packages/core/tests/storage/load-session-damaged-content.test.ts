import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';

const passthroughScrubber: SecretScrubber = { scrub: (text) => text, scrubObject: (obj) => obj };

/**
 * F2242: `user_input` and `llm_response` are the two replay branches that used
 * to copy journal content straight into `messages`. A damaged content array was
 * then dereferenced by the post-loop repair pass (outside the per-line catch),
 * which rejected the whole load instead of skipping one damaged event.
 */
describe('loadSessionDataFromFile — damaged event content (F2242)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-damaged-content-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function load(name: string, events: unknown[]) {
    const file = path.join(dir, `${name}.jsonl`);
    await fsp.writeFile(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const damaged: string[] = [];
    const data = await loadSessionDataFromFile({
      id: name,
      file,
      full: true,
      secretScrubber: passthroughScrubber,
      events: {
        emit: (type: string, payload: unknown) => {
          if (type === 'session.damaged') damaged.push(JSON.stringify(payload));
        },
      } as never,
    });
    return { data, damaged };
  }

  it.each([
    ['user_input', { type: 'user_input', ts: '2026-11-25T00:01:00.000Z', content: [null] }],
    [
      'llm_response',
      {
        type: 'llm_response',
        ts: '2026-11-25T00:01:00.000Z',
        content: [null],
        usage: { input: 3, output: 4 },
        stopReason: 'end',
        model: 'model',
        provider: 'provider',
      },
    ],
  ])('skips a damaged %s event and keeps the rest of the session', async (_label, damagedEvent) => {
    const { data, damaged } = await load(String(_label), [
      { type: 'session_start', ts: '2026-11-25T00:00:00.000Z', model: 'm', provider: 'p' },
      damagedEvent,
      { type: 'user_input', ts: '2026-11-25T00:02:00.000Z', content: 'real prompt' },
    ]);

    expect(data.messages.map((message) => message.content)).toEqual(['real prompt']);
    expect(damaged).toHaveLength(1);
  });
});
