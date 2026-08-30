import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';
import type { SecretScrubber } from '../../src/types/secret-scrubber.js';

const passthroughScrubber: SecretScrubber = {
  scrub: (text) => text,
  scrubObject: (obj) => obj,
};

/**
 * Regression: the `context_snapshot` branch of the replay switch must reset
 * `messageIndexOffset` (like `messages_replaced` always has). The writer emits
 * `message_updated` indices as positions in the CURRENT in-memory array
 * (conversation-state.ts), so after a compaction snapshot every subsequent
 * index is snapshot-relative. With the stale pre-snapshot offset still
 * applied, `index 1 - offset 1 = 0` silently overwrote the WRONG message
 * (user "s1") instead of the targeted assistant row.
 */
describe('loadSessionDataFromFile — message index offset across context_snapshot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-offset-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resets the dropped-prefix offset after a context_snapshot so later message_updated indices stay snapshot-relative', async () => {
    const ts = (minute: number) => `2026-08-29T11:${String(minute).padStart(2, '0')}:00.000Z`;
    const lines = [
      {
        type: 'session_start',
        ts: ts(0),
        model: 'test-model',
        provider: 'test-provider',
      },
      {
        type: 'message_appended',
        ts: ts(1),
        version: 1,
        message: { role: 'user', content: 'q1', ts: ts(1) },
      },
      {
        type: 'message_appended',
        ts: ts(2),
        version: 1,
        message: { role: 'assistant', content: 'a1', ts: ts(2) },
      },
      {
        type: 'message_updated',
        ts: ts(3),
        version: 1,
        index: 1,
        message: { role: 'assistant', content: 'a1 v2', ts: ts(3) },
      },
      // Retention eviction: the loader splices the prefix and accumulates
      // `messageIndexOffset = 1` — correct only for PRE-snapshot indices.
      { type: 'messages_dropped', ts: ts(4), version: 1, count: 1 },
      // Compaction snapshot: the writer's whole post-rewrite array. The
      // offset must reset here — the bug left it at 1.
      {
        type: 'context_snapshot',
        ts: ts(5),
        reason: 'compaction',
        messages: [
          { role: 'user', content: 's1', ts: ts(5) },
          { role: 'assistant', content: 's2', ts: ts(5) },
        ],
      },
      // Snapshot-relative index 1 targets the assistant row. With the stale
      // offset this resolved to index 0 and clobbered "s1".
      {
        type: 'message_updated',
        ts: ts(6),
        version: 1,
        index: 1,
        message: { role: 'assistant', content: 's2 v2', ts: ts(6) },
      },
    ].map((event) => JSON.stringify(event));
    const sessionFile = path.join(dir, 'sess.jsonl');
    await fsp.writeFile(sessionFile, lines.join('\n'), 'utf8');

    const data = await loadSessionDataFromFile({
      id: '2026-08-29/sess_offset',
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
    });

    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toMatchObject({ role: 'user', content: 's1' });
    // The targeted row is updated in place; the pre-snapshot offset must not
    // redirect the update onto index 0.
    expect(data.messages[1]).toMatchObject({ role: 'assistant', content: 's2 v2' });
  });
});
