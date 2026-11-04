// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/platform')>()),
  request,
}));

const { ConnectionDiagnostics } = await import('../src/ConnectionDiagnostics');
const { ConversationReconnect } = await import('../src/ConversationReconnect');
const { NoRecordedSession, reconnectConversation } = await import('../src/session-reconnect');
const { canReconnect, desktopStorageSize, journalStatus, recordedSessionId } = await import(
  '../src/session-reconnect-model'
);
const { surfaceI18n } = await import('../src/surface-i18n');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (status: Session['status'], kind: Session['kind'] = 'agent'): Session => ({
  id: `desk-${status}-${kind}`,
  projectId: 'p1',
  title: `Fix ${status}`,
  kind,
  workdir: 'D:/repo',
  status,
  createdAt: 1,
  updatedAt: 1_700_000_000_000,
  exitCode: null,
  error: status === 'interrupted' ? 'Session host stopped.' : null,
});

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('reconnecting a stopped conversation', () => {
  afterEach(async () => {
    request.mockReset();
    await surfaceI18n.changeLanguage('en');
  });

  it('knows which conversations can come back and what their journal recorded', () => {
    expect(canReconnect(session('interrupted'))).toBe(true);
    expect(canReconnect(session('error'))).toBe(true);
    expect(canReconnect(session('stopped'))).toBe(true);
    expect(canReconnect(session('running'))).toBe(false);
    expect(canReconnect(session('starting'))).toBe(false);
    expect(canReconnect(session('stopped', 'terminal'))).toBe(false);
    expect(
      recordedSessionId([
        { type: 'prefs.updated', payload: {} },
        { type: 'session.start', payload: { sessionId: 'sess_1' } },
        { type: 'session.start', payload: { sessionId: 'sess_2' } },
      ]),
    ).toBe('sess_1');
    expect(recordedSessionId([{ type: 'session.start', payload: { sessionId: '' } }])).toBe(
      undefined,
    );
    const progress = { open: true, hydrating: false, replay: null, lastAt: 0, sessionId: '' };
    expect(journalStatus(null)).toEqual({ kind: 'closed' });
    expect(journalStatus(progress)).toEqual({ kind: 'current' });
    expect(journalStatus({ ...progress, open: false })).toEqual({ kind: 'kept' });
    expect(
      journalStatus({ ...progress, hydrating: true, replay: { read: 50, total: 200 } }),
    ).toEqual({ kind: 'reading', percent: 25 });
    const stored = new Map([
      ['wrongstack.desktop.language', 'tr'],
      ['other', 'ignored'],
    ]);
    const keys = [...stored.keys()];
    expect(
      desktopStorageSize({
        length: keys.length,
        key: (index) => keys[index] ?? null,
        getItem: (key) => stored.get(key) ?? null,
      }),
    ).toBe('wrongstack.desktop.language'.length + 2);
  });

  it('resumes the session the journal recorded on the same conversation', async () => {
    const host = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'engine.events') return { id: params['id'] };
      return params['offset'] === 0
        ? { offset: 10, hasMore: true, events: [{ type: 'prefs.updated', payload: {} }] }
        : { offset: 20, events: [{ type: 'session.start', payload: { sessionId: 'sess_9' } }] };
    }) as never;
    await reconnectConversation('desk-1', host);
    expect((host as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['engine.events', { id: 'desk-1', offset: 0 }],
      ['engine.events', { id: 'desk-1', offset: 10 }],
      ['session.reconnect', { id: 'desk-1', history: { id: 'sess_9', mode: 'resume' } }],
    ]);
    const empty = vi.fn(async () => ({ offset: 0, events: [] })) as never;
    await expect(reconnectConversation('desk-2', empty)).rejects.toBeInstanceOf(NoRecordedSession);
  });

  it('offers the reconnect under a stopped conversation and reports a missing record', async () => {
    await surfaceI18n.changeLanguage('tr');
    request.mockResolvedValue({ offset: 0, events: [] });
    const running = await mount(
      createElement(ConversationReconnect, { session: session('running') }),
    );
    expect(running.host.textContent).toBe('');
    await running.unmount();
    const view = await mount(
      createElement(ConversationReconnect, { session: session('interrupted') }),
    );
    expect(view.host.textContent).toContain('Bu konuşmanın motoru çalışmıyor.');
    const button = view.host.querySelector('button');
    expect(button?.textContent).toBe('Yeniden bağlan');
    await act(async () => button?.click());
    expect(request).toHaveBeenCalledWith('engine.events', {
      id: 'desk-interrupted-agent',
      offset: 0,
    });
    expect(view.host.textContent).toContain('Bu konuşma hiç oturum kaydetmedi');
    expect(request).not.toHaveBeenCalledWith('session.reconnect', expect.anything());
    await view.unmount();
  });

  it('lists each conversation with its engine, journal and a reconnect where it stopped', async () => {
    const view = await mount(
      createElement(ConnectionDiagnostics, {
        sessions: [session('running'), session('interrupted'), session('stopped', 'terminal')],
      }),
    );
    const text = view.host.textContent ?? '';
    expect(text).toContain('Reconnect diagnostics');
    expect(text).toContain('1 running · 1 stopped');
    expect(text).toContain('Fix running');
    expect(text).toContain('Fix interrupted');
    // Terminals have no engine to reconnect and are not listed.
    expect(text).not.toContain('Fix stopped');
    expect(text).toContain('Not read in this window');
    expect(text).toContain('Session host stopped.');
    const reconnect = [...view.host.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(reconnect).toEqual(['Reconnect Fix interrupted']);
    await view.unmount();
  });
});
