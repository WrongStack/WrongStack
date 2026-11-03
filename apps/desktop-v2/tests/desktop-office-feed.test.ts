import type { SurfaceClient, SurfaceMessage } from '@wrongstack/project-surfaces/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopOfficeFeed } from '../src/desktop-office-feed';

function fakeClient() {
  const handlers = new Map<string, Set<(message: SurfaceMessage) => void>>();
  const client: SurfaceClient = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    findMemoriesForFile: () => undefined,
  };
  const emit = (type: string, payload: Record<string, unknown>) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, payload });
  };
  return { client, emit, handlers };
}

/** Reads a feed hook outside React: the hooks are zustand selectors over a vanilla store. */
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>();
  return {
    ...actual,
    useStore: (store: { getState: () => unknown }, selector: (state: unknown) => unknown) =>
      selector(store.getState()),
  };
});

describe('desktop office feed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks for the mailbox and a registry snapshot when it starts', () => {
    const { client } = fakeClient();
    const send = vi.fn();
    const pingFleet = vi.fn(async () => ({}));
    const { start } = desktopOfficeFeed({ client, send, projectName: 'Demo', pingFleet });
    const stop = start();
    expect(send.mock.calls.map(([message]) => message.type)).toEqual([
      'mailbox.messages',
      'mailbox.agents',
    ]);
    expect(pingFleet).toHaveBeenCalledOnce();
    stop();
  });

  it('shows the registry snapshot with each context load clamped', () => {
    const { client, emit } = fakeClient();
    const { feed, start } = desktopOfficeFeed({ client, send: vi.fn(), projectName: 'Demo' });
    const stop = start();
    emit('sessions.status_update', {
      sessions: [
        {
          sessionId: 's1',
          clientType: 'tui',
          agents: [{ id: 'leader', name: 'leader', status: 'running', ctxPct: 140.4 }],
        },
      ],
    });
    expect(feed.useLiveSessions()[0]?.agents[0]?.ctxPct).toBe(100);
    expect(feed.useProjectName()).toBe('Demo');
    expect(feed.self?.label).toBe('This desktop');
    stop();
  });

  it('keeps mailbox replies newest first and makes feed entries only for real traffic', () => {
    const { client, emit } = fakeClient();
    const send = vi.fn();
    const { feed, start } = desktopOfficeFeed({ client, send, projectName: 'Demo' });
    const stop = start();
    emit('mailbox.messages', {
      messages: [
        { id: 'old', from: 'a', to: '*', timestamp: '2026-11-03T08:00:00Z' },
        { id: 'new', from: 'b', to: '@session:s1', timestamp: '2026-11-03T09:00:00Z' },
      ],
    });
    expect(feed.useMailboxMessages().map((message) => [message.id, message.scope])).toEqual([
      ['new', 'session'],
      ['old', 'project'],
    ]);

    send.mockClear();
    emit('mailbox.event', { event: 'mailbox.agent_heartbeat', agentId: 'leader@1' });
    expect(feed.useVizEvents()).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(send).not.toHaveBeenCalled();

    emit('mailbox.event', {
      event: 'mailbox.message_sent',
      from: 'leader',
      to: 'worker',
      subject: 'Done',
    });
    expect(feed.useVizEvents()[0]).toMatchObject({ kind: 'mailbox:send', label: 'Done' });
    vi.advanceTimersByTime(400);
    expect(send.mock.calls.map(([message]) => message.type)).toEqual([
      'mailbox.messages',
      'mailbox.agents',
    ]);
    stop();
  });

  it('stops listening when stopped', () => {
    const { client, handlers } = fakeClient();
    const { start } = desktopOfficeFeed({ client, send: vi.fn(), projectName: 'Demo' });
    start()();
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
});
