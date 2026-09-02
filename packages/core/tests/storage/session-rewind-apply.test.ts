import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRewindToConversation } from '../../src/storage/session-rewind-apply.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Message } from '../../src/types/messages.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-apply-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Minimal stand-in for ConversationState's replaceMessages surface. */
function makeConversation(initial: Message[]) {
  const messages = [...initial];
  return {
    messages,
    replaceMessages(next: Message[]) {
      messages.splice(0, messages.length, ...next);
    },
  };
}

const userMsg = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as Message;

async function seedSession(store: DefaultSessionStore, id: string) {
  const w = await store.create({ id, model: 'm', provider: 'p' });
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  // Two prompts, each preceded by its checkpoint — the real writer ordering.
  await w.writeCheckpoint(0, 'first');
  await w.append({ type: 'message_appended', ts: ts(1), version: 1, message: userMsg('first') });
  await w.writeCheckpoint(1, 'second');
  await w.append({ type: 'message_appended', ts: ts(2), version: 1, message: userMsg('second') });
  await w.flush();
  return w;
}

describe('applyRewindToConversation', () => {
  it('cuts the live conversation back to the truncated log', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await seedSession(store, 'rw-1');
    const convo = makeConversation([userMsg('first'), userMsg('second')]);

    const result = await applyRewindToConversation({
      session: w,
      state: convo,
      sessionsDir: tmp,
      promptIndex: 1,
    });

    // Prompt 1's message is gone from BOTH the log and the live conversation.
    expect(result.messageCount).toBe(1);
    expect(convo.messages).toHaveLength(1);
    expect((convo.messages[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      'first',
    );
    await w.close();
  });

  it('re-anchors the journal so a later reload agrees with the live state', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await seedSession(store, 'rw-2');
    const convo = makeConversation([userMsg('first'), userMsg('second')]);

    await applyRewindToConversation({
      session: w,
      state: convo,
      sessionsDir: tmp,
      promptIndex: 1,
    });
    await w.close();

    // The rewound turn must not come back from the log on the next load.
    const reloaded = await new DefaultSessionStore({ dir: tmp }).load('rw-2');
    const texts = reloaded.messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as Array<{ text?: string }>)[0]?.text);
    expect(texts).toEqual(['first']);
  });

  it('records the reverted files on the rewound event', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await seedSession(store, 'rw-4');
    const convo = makeConversation([userMsg('first'), userMsg('second')]);

    await applyRewindToConversation({
      session: w,
      state: convo,
      sessionsDir: tmp,
      promptIndex: 1,
      revertedFiles: ['/proj/a.ts', '/proj/b.ts'],
    });
    await w.close();

    // Only the caller knows what was reverted — the file_snapshot events that
    // proved it were just truncated away, so the rewound event is the last
    // record of it.
    const events = (await new DefaultSessionStore({ dir: tmp }).load('rw-4')).events;
    const rewound = events.find((e) => e.type === 'rewound') as
      | { revertedFiles: string[] }
      | undefined;
    expect(rewound?.revertedFiles).toEqual(['/proj/a.ts', '/proj/b.ts']);
  });

  it('recounts the summary so a rewound session does not report undone work', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await store.create({ id: 'rw-5', model: 'm', provider: 'p' });
    const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

    await w.writeCheckpoint(0, 'first');
    await w.append({ type: 'tool_call_start', ts: ts(1), id: 'tc1', name: 'read_file', input: {} });
    await w.writeCheckpoint(1, 'second');
    // Work that the rewind will discard.
    await w.append({
      type: 'tool_call_start',
      ts: ts(2),
      id: 'tc2',
      name: 'write_file',
      input: {},
    });
    await w.append({ type: 'tool_call_start', ts: ts(3), id: 'tc3', name: 'exec', input: {} });
    await w.flush();

    await w.truncateToCheckpoint(1);
    await w.close();

    // list() reads .summary.json — it must describe the session that remains,
    // not the one that was rewound away.
    const summary = JSON.parse(await fs.readFile(path.join(tmp, 'rw-5.summary.json'), 'utf8')) as {
      toolCallCount: number;
      toolBreakdown?: Record<string, number>;
    };
    expect(summary.toolCallCount).toBe(1);
    expect(summary.toolBreakdown).toEqual({ read_file: 1 });
  });

  it('reports how many events the truncation dropped', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await seedSession(store, 'rw-3');
    const convo = makeConversation([userMsg('first'), userMsg('second')]);

    const result = await applyRewindToConversation({
      session: w,
      state: convo,
      sessionsDir: tmp,
      promptIndex: 1,
    });

    expect(result.removedEvents).toBeGreaterThan(0);
    await w.close();
  });
});
