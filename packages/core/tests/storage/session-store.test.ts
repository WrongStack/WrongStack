import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('DefaultSessionStore — basic lifecycle', () => {
  it('constructs without error', () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    expect(store).toBeDefined();
  });

  it('list returns empty array when no sessions exist', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const sessions = await store.list();
    expect(sessions).toEqual([]);
  });

  it('listFiltered returns empty with criteria on empty store', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const sessions = await store.listFiltered({ provider: 'openai' });
    expect(sessions).toEqual([]);
  });

  it('clearLoadCache does not throw', () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    expect(() => store.clearLoadCache()).not.toThrow();
    expect(() => store.clearLoadCache('nonexistent')).not.toThrow();
  });

  it('load throws for nonexistent session', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    await expect(store.load('nonexistent-id')).rejects.toThrow();
  });

  it('replay excludes empty assistant turns persisted by interrupted streams (#271)', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const w = await store.create({ id: 'poisoned', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'first',
    });
    // Exact shape an aborted zero-output stream used to persist.
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: '' }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: '  \n ' }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
    });
    // Meaningful turns around the malformed ones must survive replay.
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'partial before interrupt' }],
      stopReason: 'end_turn',
      usage: { input: 3, output: 1 },
    });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'second',
    });
    await w.close();

    const reloaded = await store.load('poisoned');
    expect(reloaded.messages).toEqual([
      { role: 'user', content: 'first', ts: expect.any(String) },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial before interrupt' }],
        ts: expect.any(String),
      },
      { role: 'user', content: 'second', ts: expect.any(String) },
    ]);
    // No empty assistant turn remains to break strict providers.
    for (const msg of reloaded.messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      expect(msg.content.some((b) => b.type !== 'text' || b.text.trim().length > 0)).toBe(true);
    }
  });

  it('loads and replays user_input + llm_response events', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const w = await store.create({ id: 's1', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hello',
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi back' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
      model: 'm',
    });
    await w.close();

    const data = await store.load('s1');
    expect(data.metadata.id).toBe('s1');
    expect(data.metadata.model).toBe('m');
    expect(data.messages).toHaveLength(2);
    // Replayed messages also carry the event's `ts` — match the core shape.
    expect(data.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(data.usage.input).toBe(10);
    expect(data.usage.output).toBe(5);
  });

  it('loadEventsOnly throws for nonexistent session', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    await expect(store.loadEventsOnly('nonexistent-id')).rejects.toThrow();
  });
});

describe('DefaultSessionStore — with EventBus', () => {
  it('accepts an EventBus in options', () => {
    const events = new EventBus();
    const store = new DefaultSessionStore({ dir: tmpDir, events });
    expect(store).toBeDefined();
  });

  it('accepts a projectRoot', () => {
    const store = new DefaultSessionStore({ dir: tmpDir, projectRoot: '/some/project' });
    expect(store).toBeDefined();
  });

  it('fails closed when workspace identity capture has no project root', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    await expect(store.captureWorkspaceCheckpoint('session-1', 0)).rejects.toThrow(
      'projectRoot-aware session store',
    );
  });
});

describe('DefaultSessionStore — delete on nonexistent', () => {
  it('delete does not throw for nonexistent session', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    // delete should be idempotent or throw a known error, not crash
    try {
      await store.delete('nonexistent-id');
    } catch (e) {
      // Expected — just verify it doesn't crash the process
      expect(e).toBeInstanceOf(Error);
    }
  });
});
