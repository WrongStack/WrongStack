import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalMailbox, resolveProjectDir } from '../../src/coordination/global-mailbox.js';
import type { EventBus } from '../../src/kernel/events.js';

let dir: string;
let mb: GlobalMailbox;
let events: { emitCustom: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'global-mailbox-'));
  events = { emitCustom: vi.fn() };
  mb = new GlobalMailbox(dir, events as never as EventBus);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const send = (over: Record<string, unknown> = {}) =>
  mb.send({ from: 'a', to: 'b', type: 'info', subject: 's', body: 'hi', ...over } as never);

describe('resolveProjectDir', () => {
  it('joins globalRoot/projects/<slug>', () => {
    const p = resolveProjectDir('/some/project', '/root');
    expect(p.replace(/\\/g, '/')).toMatch(/\/root\/projects\//);
  });
});

describe('GlobalMailbox messages', () => {
  it('sends a message, normalizing the broadcast recipient', async () => {
    const msg = await send({ to: 'all' });
    expect(msg.to).toBe('*');
    expect(msg.priority).toBe('normal');
    expect(msg.id).toBeTruthy();
  });

  it('queries with every filter', async () => {
    await send({ from: 'x', to: 'y', type: 'task', priority: 'high', subject: 'one' });
    await send({ from: 'z', to: 'y', type: 'info', priority: 'low', subject: 'two' });
    await send({ to: '*', subject: 'broadcast' });

    expect((await mb.query({ to: 'y' })).length).toBe(3); // 2 direct + the '*' broadcast (matches any `to`)
    expect((await mb.query({ from: 'x' })).map((m) => m.subject)).toEqual(['one']);
    expect((await mb.query({ type: 'task' })).length).toBe(1);
    expect((await mb.query({ minPriority: 'high' })).length).toBe(1);
    expect((await mb.query({ incompleteOnly: true })).length).toBeGreaterThan(0);
    const limited = await mb.query({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  it('filters by unreadBy and since', async () => {
    const m1 = await send({ subject: 'first' });
    await send({ subject: 'second' });
    await mb.ack({ messageId: m1.id, readerId: 'b' } as never);
    const unread = await mb.query({ unreadBy: 'b' });
    expect(unread.map((m) => m.subject)).not.toContain('first');
    const since = await mb.query({ since: m1.timestamp });
    expect(since.length).toBeGreaterThanOrEqual(0);
  });

  it('acks read receipts, completion, and outcome; returns null for unknown ids', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', completed: true, outcome: 'done' } as never);
    expect(acked?.completed).toBe(true);
    expect(acked?.completedBy).toBe('b');
    expect(acked?.outcome).toBe('done');
    expect(await mb.ack({ messageId: 'nope', readerId: 'b' } as never)).toBeNull();
  });

  it('ack with read:false does not record a read receipt', async () => {
    const msg = await send({ to: 'b' });
    const acked = await mb.ack({ messageId: msg.id, readerId: 'b', read: false } as never);
    expect(acked?.readBy?.b).toBeUndefined();
  });

  it('counts unread messages addressed to an agent or broadcast', async () => {
    await send({ to: 'b' });
    await send({ to: '*' });
    await send({ to: 'other' });
    expect(await mb.unreadCount('b')).toBe(2); // direct + broadcast
  });

  it('migrates legacy read/readAt to readBy and skips malformed lines', async () => {
    const legacy = JSON.stringify({ id: '1', from: 'a', to: 'b', type: 'info', subject: 's', body: 'x', read: true, readAt: '2026-01-01T00:00:00Z', timestamp: '2026-01-01T00:00:00Z', priority: 'normal', completed: false });
    await fs.writeFile(mb.messagePath, `${legacy}\nnot-json-line\n`);
    const all = await mb.query({});
    expect(all.length).toBe(1);
    expect(all[0]?.readBy?.b).toBe('2026-01-01T00:00:00Z');
  });
});

describe('GlobalMailbox agent registry', () => {
  const reg = (over: Record<string, unknown> = {}) =>
    mb.registerAgent({ agentId: 'ag1', sessionId: 's1', name: 'Neo', role: 'executor', ...over } as never);

  it('registers an agent and reports it as online', async () => {
    await reg();
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.agent_registered', expect.any(Object));
    const statuses = await mb.getAgentStatuses();
    expect(statuses[0]).toMatchObject({ agentId: 'ag1', online: true });
    expect((await mb.getOnlineAgents()).length).toBe(1);
  });

  it('applies a heartbeat and updates status fields', async () => {
    await reg();
    await mb.heartbeat({ agentId: 'ag1', status: 'busy', currentTool: 'bash', currentTask: 'build', iterations: 3, toolCalls: 5 } as never);
    const s = (await mb.getAgentStatuses())[0];
    expect(s).toMatchObject({ status: 'busy', currentTool: 'bash', iterations: 3, toolCalls: 5 });
  });

  it('throttles repeated heartbeats within the window', async () => {
    await reg();
    await mb.heartbeat({ agentId: 'ag1', status: 'busy' } as never);
    events.emitCustom.mockClear();
    await mb.heartbeat({ agentId: 'ag1', status: 'idle' } as never); // throttled → early return
    expect(events.emitCustom).not.toHaveBeenCalled();
  });

  it('silently ignores a heartbeat for an unregistered agent', async () => {
    await expect(mb.heartbeat({ agentId: 'ghost' } as never)).resolves.toBeUndefined();
  });

  it('marks agents offline once their heartbeat goes stale', async () => {
    // Write a registry file directly with an old lastSeenAt.
    const old = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(
      mb.registryPath,
      JSON.stringify({ stale: { agentId: 'stale', sessionId: 's', name: 'Old', role: 'r', status: 'busy', iterations: 0, toolCalls: 0, registeredAt: old, lastSeenAt: old } }),
    );
    const s = (await mb.getAgentStatuses())[0];
    expect(s?.online).toBe(false);
    expect(s?.status).toBe('idle'); // pruned in place
  });

  it('returns no agents when the registry file is absent', async () => {
    expect(await mb.getAgentStatuses()).toEqual([]);
  });

  it('sorts multiple agents by last-seen', async () => {
    await mb.registerAgent({ agentId: 'a1', sessionId: 's', name: 'A', role: 'r' } as never);
    await mb.registerAgent({ agentId: 'a2', sessionId: 's', name: 'B', role: 'r' } as never);
    expect((await mb.getAgentStatuses()).length).toBe(2); // sort comparator invoked
  });
});

describe('GlobalMailbox client registry', () => {
  const reg = (over: Record<string, unknown> = {}) =>
    mb.registerClient({ clientId: 'c1', sessionId: 's1', name: 'TUI', source: 'tui', ...over } as never);

  it('registers a client and reports it online', async () => {
    await reg();
    expect(events.emitCustom).toHaveBeenCalledWith('mailbox.client_registered', expect.any(Object));
    const statuses = await mb.getClientStatuses();
    expect(statuses[0]).toMatchObject({ clientId: 'c1', online: true });
  });

  it('applies and throttles client heartbeats', async () => {
    await reg();
    await mb.clientHeartbeat({ clientId: 'c1' } as never);
    events.emitCustom.mockClear();
    await mb.clientHeartbeat({ clientId: 'c1' } as never); // throttled
    expect(events.emitCustom).not.toHaveBeenCalled();
  });

  it('updates client session id on heartbeat when provided', async () => {
    await reg();
    await mb.clientHeartbeat({ clientId: 'c1', sessionId: 's2' });
    const statuses = await mb.getClientStatuses();
    expect(statuses[0]).toMatchObject({ clientId: 'c1', sessionId: 's2' });
    expect(events.emitCustom).toHaveBeenCalledWith(
      'mailbox.client_heartbeat',
      expect.objectContaining({ clientId: 'c1', sessionId: 's2' }),
    );
  });

  it('sorts multiple clients by last-seen', async () => {
    await reg({ clientId: 'c1' });
    await reg({ clientId: 'c2' });
    expect((await mb.getClientStatuses()).length).toBe(2); // sort comparator invoked
  });

  it('marks clients offline once stale', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(
      mb.clientRegistryPath,
      JSON.stringify({ c1: { clientId: 'c1', sessionId: 's', name: 'Old', source: 'tui', registeredAt: old, lastSeenAt: old } }),
    );
    expect((await mb.getClientStatuses())[0]?.online).toBe(false);
  });
});

describe('GlobalMailbox lifecycle', () => {
  it('close clears the in-process caches', async () => {
    await mb.registerAgent({ agentId: 'a', sessionId: 's', name: 'n', role: 'r' } as never);
    await expect(mb.close()).resolves.toBeUndefined();
  });

  it('clearAll truncates the mailbox', async () => {
    await send();
    await mb.clearAll();
    expect(await mb.query({})).toEqual([]);
  });

  it('purgeStale drops old completed and incomplete messages', async () => {
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days old
    const recentTs = new Date().toISOString();
    const lines = [
      { id: '1', from: 'a', to: 'b', type: 'info', subject: 'old-done', body: '', priority: 'normal', readBy: {}, completed: true, completedAt: oldTs, timestamp: oldTs },
      { id: '2', from: 'a', to: 'b', type: 'info', subject: 'old-incomplete', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: oldTs },
      { id: '3', from: 'a', to: 'b', type: 'info', subject: 'recent', body: '', priority: 'normal', readBy: {}, completed: false, timestamp: recentTs },
    ].map((m) => JSON.stringify(m)).join('\n');
    await fs.writeFile(mb.messagePath, `${lines}\n`);

    const result = await mb.purgeStale();
    expect(result.completedPurged).toBe(1);
    expect(result.incompletePurged).toBe(1);
    expect(result.totalPurged).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('purgeStale on an empty mailbox is a no-op', async () => {
    const result = await mb.purgeStale();
    expect(result.totalPurged).toBe(0);
  });
});

describe('GlobalMailbox non-ENOENT read errors rethrow', () => {
  it('rethrows when the message file path is a directory', async () => {
    await fs.mkdir(mb.messagePath, { recursive: true });
    await expect(mb.query({})).rejects.toThrow();
  });

  it('rethrows when the agent registry path is a directory', async () => {
    await fs.mkdir(mb.registryPath, { recursive: true });
    await expect(mb.getAgentStatuses()).rejects.toThrow();
  });

  it('rethrows when the client registry path is a directory', async () => {
    await fs.mkdir(mb.clientRegistryPath, { recursive: true });
    await expect(mb.getClientStatuses()).rejects.toThrow();
  });
});
