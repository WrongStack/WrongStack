/**
 * `messages_dropped` — the delta form of front-eviction.
 *
 * Eviction is the one conversation rewrite that repeats: once a session reaches
 * `Context.MAX_MESSAGES`, every append overflows by one and drops one. Writing
 * the surviving history each time made the journal quadratic in session length
 * (measured: a 2.1 GB session file carrying ~10 MB of conversation, and 17.9 GB
 * across a 20 GB corpus).
 *
 * The delta is only worth anything if replay reconstructs *exactly* what the
 * snapshot would have — so the load-bearing test here is the round trip against
 * live state, not the byte count. The byte count is pinned too, because a change
 * that quietly reverted to snapshotting would still pass the round trip.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Message } from '../../src/types/messages.js';
import type { Provider } from '../../src/types/provider.js';

let dir: string;
const SESSION_ID = 'sess_messages_dropped';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dropped-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message;
}

const sessionFile = (): string => path.join(dir, `${SESSION_ID}.jsonl`);

async function writeSession(events: unknown[]): Promise<void> {
  await fs.writeFile(sessionFile(), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const start = {
  type: 'session_start',
  ts: '2026-01-01T00:00:00.000Z',
  id: SESSION_ID,
  model: 'm',
  provider: 'p',
};

const appended = (ts: string, text: string) => ({
  type: 'message_appended',
  ts,
  version: 1,
  message: userMessage(text),
});

describe('messages_dropped replay', () => {
  it('splices the same prefix a snapshot would have removed', async () => {
    await writeSession([
      start,
      appended('2026-01-01T00:01:00.000Z', 'a'),
      appended('2026-01-01T00:02:00.000Z', 'b'),
      appended('2026-01-01T00:03:00.000Z', 'c'),
      appended('2026-01-01T00:04:00.000Z', 'd'),
      { type: 'messages_dropped', ts: '2026-01-01T00:05:00.000Z', version: 1, count: 2 },
      appended('2026-01-01T00:06:00.000Z', 'e'),
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    const texts = data.messages.map((m) => JSON.stringify(m.content));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('"c"');
    expect(texts[1]).toContain('"d"');
    expect(texts[2]).toContain('"e"');
  });

  it('clamps a count larger than the history instead of throwing', async () => {
    await writeSession([
      start,
      appended('2026-01-01T00:01:00.000Z', 'only'),
      { type: 'messages_dropped', ts: '2026-01-01T00:02:00.000Z', version: 1, count: 99 },
      appended('2026-01-01T00:03:00.000Z', 'after'),
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    expect(data.messages).toHaveLength(1);
    expect(JSON.stringify(data.messages[0]?.content)).toContain('after');
  });

  it('applies message_updated by absolute index after a prefix drop', async () => {
    await writeSession([
      start,
      appended('2026-01-01T00:01:00.000Z', 'a'),
      appended('2026-01-01T00:02:00.000Z', 'b'),
      appended('2026-01-01T00:03:00.000Z', 'c'),
      { type: 'messages_dropped', ts: '2026-01-01T00:04:00.000Z', version: 1, count: 2 },
      {
        type: 'message_updated',
        ts: '2026-01-01T00:05:00.000Z',
        version: 1,
        index: 2,
        message: userMessage('c-updated'),
      },
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    expect(data.messages).toHaveLength(1);
    expect(JSON.stringify(data.messages[0]?.content)).toContain('c-updated');
  });

  it('ignores a malformed count rather than corrupting the history', async () => {
    await writeSession([
      start,
      appended('2026-01-01T00:01:00.000Z', 'a'),
      { type: 'messages_dropped', ts: '2026-01-01T00:02:00.000Z', version: 1, count: -3 },
      { type: 'messages_dropped', ts: '2026-01-01T00:03:00.000Z', version: 1, count: 1.5 },
    ]);

    const data = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    expect(data.messages).toHaveLength(1);
    expect(JSON.stringify(data.messages[0]?.content)).toContain('"a"');
  });

  /**
   * The end-to-end property: drive a real Context past its message cap, reload
   * the journal it wrote, and require the reconstruction to equal live state.
   */
  it('round-trips a real over-cap conversation and stays small on disk', async () => {
    const store = new DefaultSessionStore({ dir });
    const session = await store.create({ id: SESSION_ID, model: 'm', provider: 'p' });
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as Provider,
      session,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: dir,
      projectRoot: dir,
      model: 'm',
    });

    const overflowBy = 25;
    const total = Context.MAX_MESSAGES + overflowBy;
    // Each message is fat enough that a per-append snapshot of the retained
    // history would be unmistakable in the file size.
    const filler = 'x'.repeat(2_000);
    for (let i = 0; i < total; i++) {
      ctx.state.appendMessage(userMessage(`msg-${i}-${filler}`));
    }
    await ctx.flushConversationJournal?.();
    await session.flush?.();

    const live = ctx.messages;
    expect(live).toHaveLength(Context.MAX_MESSAGES);

    const reloaded = await new DefaultSessionStore({ dir }).load(SESSION_ID);
    expect(reloaded.messages).toHaveLength(live.length);
    expect(reloaded.messages.map((m) => JSON.stringify(m.content))).toEqual(
      live.map((m) => JSON.stringify(m.content)),
    );

    // A snapshot per overflowing append would be ~overflowBy * MAX_MESSAGES *
    // 2 KB ≈ 50 MB. The delta journal is bounded by the messages themselves.
    const bytes = (await fs.stat(sessionFile())).size;
    expect(bytes).toBeLessThan(12 * 1024 * 1024);
    await session.close();
  });
});
