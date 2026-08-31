/**
 * Snapshot-payload retention in the session loader.
 *
 * `messages_replaced` / `context_snapshot` each carry a full copy of the
 * conversation and one is written per compaction, so retaining all of them
 * made a load cost one whole conversation per compaction. Replay must still
 * see every payload (the fold depends on it) while the returned `events` keeps
 * only the newest — these tests pin both halves, because a change that broke
 * the fold and a change that stopped stripping would each still "work".
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { SecretScrubber } from '../../src/types/secret-scrubber.js';

const passthroughScrubber: SecretScrubber = {
  scrub: (text) => text,
  scrubObject: (obj) => obj,
};

let dir: string;
let sessionFile: string;
const SESSION_ID = 'sess_snapshot_retention';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-snapshot-'));
  sessionFile = path.join(dir, `${SESSION_ID}.jsonl`);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const userMessage = (text: string) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ts: '2026-01-01T00:00:00.000Z',
});

async function writeSession(events: unknown[]): Promise<void> {
  await fs.writeFile(sessionFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const start = {
  type: 'session_start',
  ts: '2026-01-01T00:00:00.000Z',
  id: SESSION_ID,
  model: 'm',
  provider: 'p',
};

const snapshot = (ts: string, texts: string[]) => ({
  type: 'messages_replaced',
  ts,
  version: 1,
  messages: texts.map(userMessage),
});

describe('session loader snapshot payload retention', () => {
  it('replays from the newest snapshot while dropping the ones it superseded', async () => {
    await writeSession([
      start,
      snapshot('2026-01-01T00:01:00.000Z', ['gen-1-a', 'gen-1-b']),
      snapshot('2026-01-01T00:02:00.000Z', ['gen-2-a', 'gen-2-b', 'gen-2-c']),
      snapshot('2026-01-01T00:03:00.000Z', ['gen-3-only']),
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);

    // The fold still saw every payload: the final state comes from the last.
    expect(data.messages).toHaveLength(1);
    expect(JSON.stringify(data.messages[0]?.content)).toContain('gen-3-only');

    const snapshots = data.events.filter((e) => e.type === 'messages_replaced');
    expect(snapshots).toHaveLength(3);

    // Superseded snapshots keep their place in the timeline but not their bulk.
    expect(snapshots[0]).toMatchObject({ messages: [], messagesOmitted: 2 });
    expect(snapshots[1]).toMatchObject({ messages: [], messagesOmitted: 3 });

    // The newest keeps its payload — it is the one that decided final state.
    const newest = snapshots[2] as { messages: unknown[]; messagesOmitted?: number };
    expect(newest.messages).toHaveLength(1);
    expect(newest.messagesOmitted).toBeUndefined();
  });

  it('strips context_snapshot payloads on the same rule', async () => {
    await writeSession([
      start,
      {
        type: 'context_snapshot',
        ts: '2026-01-01T00:01:00.000Z',
        reason: 'compaction',
        messages: [userMessage('old')],
      },
      {
        type: 'context_snapshot',
        ts: '2026-01-01T00:02:00.000Z',
        reason: 'compaction',
        messages: [userMessage('new')],
      },
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    const snaps = data.events.filter((e) => e.type === 'context_snapshot');

    expect(snaps[0]).toMatchObject({ messages: [], messagesOmitted: 1 });
    expect((snaps[1] as { messages: unknown[] }).messages).toHaveLength(1);
    expect(JSON.stringify(data.messages)).toContain('new');
  });

  it('supersedes across snapshot kinds, not just within one kind', async () => {
    await writeSession([
      start,
      snapshot('2026-01-01T00:01:00.000Z', ['replaced-payload']),
      {
        type: 'context_snapshot',
        ts: '2026-01-01T00:02:00.000Z',
        reason: 'compaction',
        messages: [userMessage('survivor')],
      },
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);

    const replaced = data.events.find((e) => e.type === 'messages_replaced');
    expect(replaced).toMatchObject({ messages: [], messagesOmitted: 1 });
    const kept = data.events.find((e) => e.type === 'context_snapshot') as { messages: unknown[] };
    expect(kept.messages).toHaveLength(1);
  });

  it('leaves a lone snapshot untouched', async () => {
    await writeSession([start, snapshot('2026-01-01T00:01:00.000Z', ['only'])]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    const only = data.events.find((e) => e.type === 'messages_replaced') as {
      messages: unknown[];
      messagesOmitted?: number;
    };

    expect(only.messages).toHaveLength(1);
    expect(only.messagesOmitted).toBeUndefined();
  });

  it('refunds stripped snapshot bytes so the retention budget tracks live size', async () => {
    // Source bytes are dominated by snapshot payloads that get stripped. A
    // budget charged on raw line length would evict here; charged on what is
    // actually resident, it must not.
    const fat = (ts: string) =>
      snapshot(
        ts,
        Array.from({ length: 400 }, (_, i) => `pad-${i}`.repeat(20)),
      );
    await writeSession([
      start,
      fat('2026-01-01T00:01:00.000Z'),
      fat('2026-01-01T00:02:00.000Z'),
      fat('2026-01-01T00:03:00.000Z'),
      fat('2026-01-01T00:04:00.000Z'),
    ]);
    const sourceBytes = (await fs.stat(sessionFile)).size;

    const data = await loadSessionDataFromFile({
      id: SESSION_ID,
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
      // Well under the raw file size — only the refund keeps us inside it.
      maxRetainedEventBytes: Math.floor(sourceBytes / 2),
    });

    expect(data.eventsDropped).toBeUndefined();
    expect(data.events).toHaveLength(5);
  });

  it('drops oldest events past the budget without disturbing replay', async () => {
    const inputs = Array.from({ length: 60 }, (_, i) => ({
      type: 'user_input',
      ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      content: [{ type: 'text', text: `turn-${i}-${'x'.repeat(500)}` }],
    }));
    await writeSession([start, ...inputs]);

    const bounded = await loadSessionDataFromFile({
      id: SESSION_ID,
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
      maxRetainedEventBytes: 4_000,
    });
    const unbounded = await loadSessionDataFromFile({
      id: SESSION_ID,
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
    });

    // The budget engaged, and it took the oldest.
    expect(bounded.eventsDropped).toBeGreaterThan(0);
    expect(bounded.events.length).toBeLessThan(unbounded.events.length);
    expect(JSON.stringify(bounded.events)).toContain('turn-59');
    expect(JSON.stringify(bounded.events)).not.toContain('turn-0-');

    // Replay is built as lines arrive, so it is identical either way. This is
    // the property that makes front-eviction safe.
    expect(bounded.messages).toHaveLength(unbounded.messages.length);
    expect(JSON.stringify(bounded.messages)).toBe(JSON.stringify(unbounded.messages));
  });

  it('retains the latest subagent policy after its event is evicted', async () => {
    const inputs = Array.from({ length: 60 }, (_, i) => ({
      type: 'user_input',
      ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      content: [{ type: 'text', text: `turn-${i}-${'x'.repeat(500)}` }],
    }));
    await writeSession([
      start,
      { type: 'subagent_policy', ts: '2026-01-01T00:00:01.000Z', allowed: false },
      ...inputs,
    ]);

    const data = await loadSessionDataFromFile({
      id: SESSION_ID,
      file: sessionFile,
      full: true,
      secretScrubber: passthroughScrubber,
      maxRetainedEventBytes: 4_000,
    });

    expect(data.eventsDropped).toBeGreaterThan(0);
    expect(data.events.some((event) => event.type === 'subagent_policy')).toBe(false);
    expect(data.subagentsAllowed).toBe(false);
  });

  it('does not disturb non-snapshot events', async () => {
    await writeSession([
      start,
      {
        type: 'user_input',
        ts: '2026-01-01T00:01:00.000Z',
        content: [{ type: 'text', text: 'hi' }],
      },
      snapshot('2026-01-01T00:02:00.000Z', ['a']),
      snapshot('2026-01-01T00:03:00.000Z', ['b']),
      {
        type: 'user_input',
        ts: '2026-01-01T00:04:00.000Z',
        content: [{ type: 'text', text: 'bye' }],
      },
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    const inputs = data.events.filter((e) => e.type === 'user_input');

    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs)).toContain('hi');
    expect(JSON.stringify(inputs)).toContain('bye');
  });
});
