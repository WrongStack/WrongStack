import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExploreCompanion,
  type ExploreCompanionOptions,
  type ExploreProbe,
} from '../../src/coordination/explore-companion.js';
import type {
  Mailbox,
  MailboxAckInput,
  MailboxMessage,
  MailboxQuery,
} from '../../src/coordination/mailbox-types.js';

const live: ExploreCompanion[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.stop();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
function harness(opts: Partial<ExploreCompanionOptions> = {}) {
  const events = new EventBus();
  const dispatched: ExploreProbe[] = [];
  const finishes: Array<() => void> = [];
  const clock = { now: 1000 };
  const mailbox = {
    query: vi.fn(async (_q: MailboxQuery) => [] as MailboxMessage[]),
    ack: vi.fn(async (_input: MailboxAckInput) => null),
  };
  const c = new ExploreCompanion({
    events,
    mailbox: mailbox as unknown as Mailbox,
    leaderSessionId: 'session',
    leaderAgentId: 'leader',
    pollIntervalMs: 5,
    now: () => clock.now,
    onProbe: async (probe) => {
      dispatched.push(probe);
      await new Promise<void>((resolve) => {
        finishes.push(resolve);
      });
      return { subagentId: 'r', taskId: probe.id };
    },
    ...opts,
  });
  live.push(c);
  c.start();
  const emit = (file: string, name = 'edit') =>
    events.emit('tool.executed', {
      id: `${name}:${file}`,
      sessionId: 'session',
      name,
      ok: true,
      durationMs: 1,
      input: { path: file },
    });
  return { c, events, dispatched, finishes, clock, mailbox, emit };
}
function message(id: string, overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id,
    from: 'leader',
    to: 'explore-companion',
    type: 'ask',
    subject: 'Find parser',
    body: 'Locate Parser',
    readBy: {},
    completed: false,
    priority: 'normal',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Explore Companion queue policy and delayed I/O', () => {
  it('tracks the built-in replace tool as an unread edit', () => {
    const h = harness();
    h.emit('src/a.ts', 'replace');
    expect(h.dispatched[0]?.source).toBe('edit_unread_file');
  });

  it('extracts the actual symbol rather than boilerplate error words', () => {
    const h = harness();
    h.events.emit('error', {
      sessionId: 'session',
      phase: 'tool',
      err: new Error('TypeError: Cannot resolve UserRegistry'),
    });
    expect(h.dispatched[0]?.hint?.symbol).toBe('UserRegistry');
    expect(h.c.pendingCount()).toBe(0);
  });

  it('skips runtime JS/TS stack and assertion boilerplate words so real symbols are probed', () => {
    const h = harness();
    h.events.emit('error', {
      sessionId: 'session',
      phase: 'tool',
      err: new Error(
        'TypeError: Expected String but Received Object at Function.Module.InvoiceValidator',
      ),
    });
    expect(h.dispatched[0]?.hint?.symbol).toBe('InvoiceValidator');
    expect(h.c.pendingCount()).toBe(0);
  });

  it('recognizes codebase-context and codebase-impact-analysis as view tools and empty JSON searches without count', () => {
    const h = harness({ signals: { unfamiliarRead: false } });
    h.emit('src/viewed.ts', 'codebase-context');
    h.emit('src/viewed.ts', 'edit');
    expect(h.dispatched).toEqual([]);
    h.events.emit('tool.executed', {
      id: 'empty-json-search',
      sessionId: 'session',
      name: 'codebase-search',
      ok: true,
      durationMs: 1,
      input: { symbol: 'MissingAdapter' },
      output: JSON.stringify({ results: [] }),
    });
    expect(h.dispatched[0]?.source).toBe('search_zero_hits');
    expect(h.dispatched[0]?.hint?.symbol).toBe('MissingAdapter');
  });

  it('preserves complete Windows file paths in error hints', () => {
    const h = harness();
    h.events.emit('error', {
      sessionId: 'session',
      phase: 'tool',
      err: new Error("Cannot find module 'C:\\repo\\src\\service.ts'"),
    });
    expect(h.dispatched[0]?.hint?.file).toBe('C:\\repo\\src\\service.ts');
  });
  it('ordinary retuning keeps accepted queued work; disabling clears it', () => {
    const h = harness();
    h.emit('src/active.ts');
    h.emit('src/queued.ts');
    h.c.reconfigure({ cooldownMs: 123 });
    expect(h.c.pendingCount()).toBe(1);
    h.c.reconfigure({ enabled: false });
    expect(h.c.pendingCount()).toBe(0);
  });

  it('accepts the legacy leader tag belonging to this companion incarnation', async () => {
    vi.useFakeTimers();
    const h = harness({ companionAgentId: 'explore-companion@abc12345' });
    h.mailbox.query.mockResolvedValue([message('tagged', { from: 'leader@abc12345' })]);
    await vi.advanceTimersByTimeAsync(6);
    expect(h.dispatched[0]?.subject).toBe('mail:tagged');
  });
  it('retains explicit asks at capacity and retries an ask it could not accept', async () => {
    vi.useFakeTimers();
    const h = harness({ maxPending: 1 });
    h.emit('src/active.ts');
    h.mailbox.query.mockImplementation(async (q) =>
      [message('first'), message('second')].filter(
        (m) =>
          (q.to === m.to || m.to === '*') &&
          q.type === m.type &&
          !h.mailbox.ack.mock.calls.some(
            ([ack]) => (ack as { messageId: string }).messageId === m.id,
          ),
      ),
    );
    await vi.advanceTimersByTimeAsync(6);
    h.emit('src/new.ts', 'read');
    h.emit('src/edited.ts');
    expect(h.c.pendingCount()).toBe(1);
    expect(h.mailbox.ack).toHaveBeenCalledTimes(1);
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched[1]?.subject).toBe('mail:first');
    await vi.advanceTimersByTimeAsync(6);
    expect(h.mailbox.ack).toHaveBeenCalledTimes(2);
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched[2]?.subject).toBe('mail:second');
  });

  it('error recovery runs before queued low-priority unfamiliar reads', async () => {
    const h = harness();
    h.emit('src/active.ts');
    h.emit('src/low.ts', 'read');
    h.emit('src/urgent.ts', 'read');
    h.events.emit('error', {
      sessionId: 'session',
      phase: 'tool',
      err: new Error('UrgentSymbol failed'),
    });
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched[1]?.source).toBe('error_symbol');
    expect(h.dispatched[1]?.hint?.symbol).toBe('UrgentSymbol');
  });

  it('coalesces queued duplicates even with zero cooldown', async () => {
    const h = harness({ cooldownMs: 0 });
    h.emit('src/active.ts');
    h.emit('src/queued.ts');
    h.emit('src/queued.ts');
    expect(h.c.pendingCount()).toBe(1);
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched.map((p) => p.hint?.file)).toEqual(['src/active.ts', 'src/queued.ts']);
  });

  it('discards stale automatic work while preserving a direct ask', async () => {
    vi.useFakeTimers();
    const h = harness({ maxProbeAgeMs: 10 });
    h.emit('src/active.ts');
    h.emit('src/stale.ts');
    h.mailbox.query.mockResolvedValue([message('ask')]);
    await vi.advanceTimersByTimeAsync(6);
    h.clock.now += 11;
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched[1]?.source).toBe('mailbox_ask');
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched).toHaveLength(2);
    expect(h.c.pendingCount()).toBe(0);
  });

  it('zero pending capacity allows the active probe and rejects backlog', async () => {
    const h = harness({ maxPending: 0 });
    h.emit('src/a.ts');
    h.emit('src/b.ts');
    expect(h.c.pendingCount()).toBe(0);
    h.finishes.shift()!();
    await flush();
    expect(h.dispatched).toHaveLength(1);
  });

  it('a delayed mailbox query cannot dispatch or acknowledge after stop', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolve!: (msgs: MailboxMessage[]) => void;
    const delayed = new Promise<MailboxMessage[]>((finish) => {
      resolve = finish;
    });
    h.mailbox.query.mockReturnValue(delayed);
    await vi.advanceTimersByTimeAsync(6);
    h.c.stop();
    resolve([message('late')]);
    await flush();
    expect(h.dispatched).toEqual([]);
    expect(h.mailbox.ack).not.toHaveBeenCalled();
  });

  it('does not overlap mailbox polling while a query is unresolved', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.mailbox.query.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(6);
    const calls = h.mailbox.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30);
    expect(h.mailbox.query).toHaveBeenCalledTimes(calls);
  });

  it('filters recipient and type before applying the mailbox result limit', async () => {
    vi.useFakeTimers();
    const h = harness();
    const noise = Array.from({ length: 30 }, (_, i) => message(`noise-${i}`, { to: 'reviewer' }));
    h.mailbox.query.mockImplementation(async (q) =>
      [...noise, message('target')]
        .filter((m) => (q.to === m.to || m.to === '*') && q.type === m.type)
        .slice(0, q.limit),
    );
    await vi.advanceTimersByTimeAsync(6);
    expect(h.dispatched[0]?.subject).toBe('mail:target');
    expect(h.mailbox.ack).toHaveBeenCalledTimes(1);
  });

  it('rejects an unstamped leader identity naming a different session', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.mailbox.query.mockResolvedValue([message('foreign', { from: 'leader@other-session' })]);
    await vi.advanceTimersByTimeAsync(6);
    expect(h.dispatched).toEqual([]);
    expect(h.mailbox.ack).not.toHaveBeenCalled();
  });

  it('rejects unstamped events while the lazy session getter is unresolved', () => {
    const h = harness({ leaderSessionId: () => undefined });
    h.events.emit('tool.executed', {
      id: 'unstamped',
      name: 'edit',
      durationMs: 1,
      ok: true,
      input: { path: 'src/a.ts' },
    });
    expect(h.dispatched).toEqual([]);
  });

  it('recognizes absolute, relative, and slash variants of the same read path', () => {
    const h = harness({ projectRoot: process.cwd(), signals: { unfamiliarRead: false } });
    h.emit(path.resolve('src/a.ts'), 'read');
    h.emit('./src/a.ts');
    h.emit('src\\a.ts');
    expect(h.dispatched).toEqual([]);
  });

  it('runtime tool-set changes are recognized without reverting signal switches', () => {
    const h = harness({ signals: { unfamiliarRead: false } });
    expect(h.c.reconfigure({ fileEditTools: ['custom-edit'] })).toBe(true);
    h.c.reconfigure({ maxPending: 3 });
    h.emit('src/a.ts', 'edit');
    h.emit('src/b.ts', 'custom-edit');
    expect(h.dispatched.map((p) => p.hint?.file)).toEqual(['src/b.ts']);
  });

  it('does not turn a nonempty JSON search result containing total: 0 text into a probe', () => {
    const h = harness();
    h.events.emit('tool.executed', {
      id: 'nonempty-search',
      sessionId: 'session',
      name: 'grep',
      ok: true,
      durationMs: 1,
      input: { pattern: 'total' },
      output: JSON.stringify({ matches: ['src/a.ts:1: total: 0'], count: 1 }),
    });
    expect(h.dispatched).toEqual([]);
  });
});
