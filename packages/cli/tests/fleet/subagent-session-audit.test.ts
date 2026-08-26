import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { EventBus } from '@wrongstack/core/kernel';
import { createSessionEventBridge, DefaultSessionStore } from '@wrongstack/core/storage';
import type { SessionEvent } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSubagentSessionAudit } from '../../src/fleet/host-subagent-session-audit.js';

/**
 * The two record types a subagent's own transcript never contained.
 *
 * A subagent gets the same `DefaultSessionStore` writer the leader does, but
 * the leader's `tool_call_*` and `session_end` records are written by
 * `session-event-wiring`, which subscribes to the HOST EventBus — and every
 * subagent runs on a private `new EventBus()`. Across a 3,156-transcript
 * corpus, not one subagent JSONL held a `tool_call_start`, `tool_call_end`, or
 * `session_end`, which left every subagent summary reporting `toolCallCount: 0`
 * and made a cleanly finished worker indistinguishable from a crashed one.
 */
describe('subagent session audit', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sub-audit-'));
    store = new DefaultSessionStore({ dir: tmp });
  });
  afterEach(async () => {
    await store.dispose?.();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const readEvents = async (id: string): Promise<SessionEvent[]> => {
    const raw = await fs.readFile(path.join(tmp, `${id}.jsonl`), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEvent);
  };

  it('journals tool lifecycle and a terminal session_end carrying its own usage', async () => {
    const events = new EventBus();
    const session = await store.create({ id: 'worker-1', model: 'm', provider: 'p' });
    const tokenCounter = new DefaultTokenCounter();
    const audit = installSubagentSessionAudit({
      events,
      session,
      tokenCounter,
      bridge: createSessionEventBridge(session, 'standard'),
    });

    events.emit('tool.started', { name: 'read', id: 'tu-1', input: { path: 'a.ts' } });
    events.emit('tool.executed', {
      name: 'read',
      id: 'tu-1',
      durationMs: 12,
      ok: true,
      outputBytes: 400,
      outputTokens: 100,
    });
    // Spend the subagent accrued on its OWN counter — never the leader's.
    tokenCounter.account({ input: 1_000, output: 50, cacheRead: 20_000 });

    await session.flush();
    await audit.finalize();
    await session.close();

    const journal = await readEvents('worker-1');
    const start = journal.find((e) => e.type === 'tool_call_start');
    const end = journal.find((e) => e.type === 'tool_call_end');
    const terminal = journal.find((e) => e.type === 'session_end');

    expect(start).toMatchObject({ name: 'read', id: 'tu-1' });
    expect(end).toMatchObject({ name: 'read', id: 'tu-1', durationMs: 12, ok: true });
    // Legacy `outputSize` stays populated alongside `outputBytes`.
    expect(end).toMatchObject({ outputSize: 400, outputBytes: 400, outputTokens: 100 });
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({
      usage: { input: 1_000, output: 50, cacheRead: 20_000 },
    });

    // The summary can now count the work: this was `toolCallCount: 0` before.
    const summary = (await store.list()).find((s) => s.id.endsWith('worker-1'));
    expect(summary?.toolCallCount).toBe(1);
    expect(summary?.toolBreakdown).toEqual({ read: 1 });
    expect(summary?.outcome).toBe('completed');
  });

  it('honors a minimal audit level for tool records but always writes session_end', async () => {
    const events = new EventBus();
    const session = await store.create({ id: 'worker-2', model: 'm', provider: 'p' });
    const audit = installSubagentSessionAudit({
      events,
      session,
      tokenCounter: new DefaultTokenCounter(),
      // `minimal` drops STANDARD-level audit events — the same gate the
      // leader's SessionEventBridge applies, rather than a second policy.
      bridge: createSessionEventBridge(session, 'minimal'),
    });

    events.emit('tool.started', { name: 'read', id: 'tu-1', input: {} });
    events.emit('tool.executed', { name: 'read', id: 'tu-1', durationMs: 1, ok: true });

    await session.flush();
    await audit.finalize();
    await session.close();

    const journal = await readEvents('worker-2');
    expect(journal.some((e) => e.type === 'tool_call_start')).toBe(false);
    expect(journal.some((e) => e.type === 'tool_call_end')).toBe(false);
    // session_end is a core reconstruct event — never gated.
    expect(journal.some((e) => e.type === 'session_end')).toBe(true);
  });

  it('writes exactly one session_end when finalize runs twice', async () => {
    const events = new EventBus();
    const session = await store.create({ id: 'worker-3', model: 'm', provider: 'p' });
    const audit = installSubagentSessionAudit({
      events,
      session,
      tokenCounter: new DefaultTokenCounter(),
      bridge: createSessionEventBridge(session, 'standard'),
    });

    await audit.finalize();
    await audit.finalize();
    await session.close();

    const journal = await readEvents('worker-3');
    expect(journal.filter((e) => e.type === 'session_end')).toHaveLength(1);
  });
});
