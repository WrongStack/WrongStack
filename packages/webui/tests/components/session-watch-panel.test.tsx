import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SessionWatchPanel is a read-only tail of another process's session plus a
 * two-way composer. Everything it does goes through `fetch` (three endpoints)
 * and the monitor store's `liveSessions` snapshot, so both are driven directly
 * here rather than through a socket.
 */

vi.mock('./WatchMessageBubble.js', () => ({}));

vi.mock('@/components/WatchMessageBubble.js', () => ({
  WatchMessageBubble: ({
    entry,
    isContinuation,
  }: {
    entry: { role: string; text: string };
    isContinuation: boolean;
  }) => (
    <div data-testid="bubble" data-role={entry.role} data-continuation={String(isContinuation)}>
      {entry.text}
    </div>
  ),
}));

const { SessionWatchPanel } = await import('@/components/SessionWatchPanel');
const { useMonitorStore } = await import('@/stores/monitor-store');

const SESSION = 'sess_watched';

interface Routes {
  events?: unknown;
  mailbox?: unknown;
  message?: { ok: boolean; status?: number };
  interrupt?: { ok: boolean; status?: number };
}

let routes: Routes;
const fetchMock = vi.fn();

/** Route by path so each endpoint can fail independently. */
function installFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/events')) {
      const body = routes.events;
      if (body instanceof Error) return Promise.reject(body);
      if (body === undefined) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    if (url.includes('/mailbox')) {
      const body = routes.mailbox;
      if (body instanceof Error) return Promise.reject(body);
      if (body === undefined) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    if (url.includes('/message')) return Promise.resolve(routes.message ?? { ok: true, status: 200 });
    if (url.includes('/interrupt'))
      return Promise.resolve(routes.interrupt ?? { ok: true, status: 200 });
    return Promise.resolve({ ok: false, status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function events(entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    status: 'active',
    total: entries.length,
    entries,
    ...extra,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return { id: 'leader', name: 'Leader', status: 'idle', toolCalls: 0, iterations: 0, ...overrides };
}

function liveSession(overrides: Record<string, unknown> = {}) {
  useMonitorStore.setState({
    liveSessions: [{ sessionId: SESSION, status: 'idle', agents: [agent()], ...overrides }],
  } as never);
}

async function mount(props: Record<string, unknown> = {}) {
  const view = render(<SessionWatchPanel sessionId={SESSION} {...props} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return view;
}

/** The URLs hit so far, for asserting on which endpoints were called. */
function urls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  routes = { events: events([]), mailbox: { thread: [] } };
  installFetch();
  useMonitorStore.setState({ liveSessions: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('event stream', () => {
  it('requests the events endpoint with the default limit', async () => {
    await mount();
    expect(urls()[0]).toBe(`/api/sessions/${SESSION}/events?limit=200`);
  });

  it('honours an explicit limit', async () => {
    await mount({ limit: 500 });
    expect(urls()[0]).toContain('limit=500');
  });

  it('encodes a session id with url-unsafe characters', async () => {
    render(<SessionWatchPanel sessionId="a/b c" />);
    await waitFor(() => expect(urls()[0]).toContain('a%2Fb%20c'));
  });

  it('renders one bubble per entry', async () => {
    routes.events = events([
      { ts: '1', role: 'user', text: 'hello' },
      { ts: '2', role: 'assistant', text: 'hi' },
    ]);
    await mount();

    await waitFor(() => expect(screen.getAllByTestId('bubble')).toHaveLength(2));
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('marks a repeated role as a continuation', async () => {
    routes.events = events([
      { ts: '1', role: 'assistant', text: 'one' },
      { ts: '2', role: 'assistant', text: 'two' },
      { ts: '3', role: 'user', text: 'three' },
    ]);
    await mount();

    await waitFor(() => expect(screen.getAllByTestId('bubble')).toHaveLength(3));
    const flags = screen.getAllByTestId('bubble').map((b) => b.dataset.continuation);
    expect(flags).toEqual(['false', 'true', 'false']);
  });

  it('shows a loading line while there is nothing yet', async () => {
    await mount();
    expect(screen.getByText(/loading|yükleniyor/i)).toBeTruthy();
  });

  it('surfaces the http status when the fetch is rejected', async () => {
    routes.events = undefined;
    await mount();
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
  });

  it('surfaces a network failure message', async () => {
    routes.events = new Error('offline');
    await mount();
    await waitFor(() => expect(screen.getByText(/offline/)).toBeTruthy());
  });

  it('shows the event count and status once loaded', async () => {
    routes.events = events([{ ts: '1', role: 'user', text: 'x' }], { status: 'active' });
    await mount();
    await waitFor(() => expect(screen.getByText(/active/)).toBeTruthy());
  });
});

describe('live registry signals', () => {
  it('offers the interrupt button while the session is active', async () => {
    liveSession({ status: 'active' });
    await mount();
    expect(screen.getByTitle(/Cooperatively stop/i)).toBeTruthy();
  });

  it('treats a running agent as active even when the session says idle', async () => {
    liveSession({ status: 'idle', agents: [agent({ status: 'running' })] });
    await mount();
    expect(screen.getByTitle(/Cooperatively stop/i)).toBeTruthy();
  });

  it('hides the interrupt button when nothing is running', async () => {
    liveSession({ status: 'idle' });
    await mount();
    expect(screen.queryByTitle(/Cooperatively stop/i)).toBeNull();
  });

  it('shows the current tool of the busy agent', async () => {
    liveSession({ agents: [agent({ status: 'running', currentTool: 'Grep' })] });
    await mount();
    expect(screen.getByText(/🔧 Grep/)).toBeTruthy();
  });

  it('falls back to a generic working line when there is no tool name', async () => {
    liveSession({ agents: [agent({ id: 'sa1', name: 'scout', status: 'running' })] });
    await mount();
    expect(screen.getByText(/▶/)).toBeTruthy();
  });

  it('shows nothing when the watched session is not in the registry', async () => {
    await mount();
    expect(screen.queryByText(/▶/)).toBeNull();
  });

  it('renders the streaming tail of the busy agent', async () => {
    liveSession({
      agents: [agent({ id: 'sa1', name: 'scout', status: 'streaming', partialText: 'thinking…' })],
    });
    await mount();

    expect(screen.getByText(/thinking…/)).toBeTruthy();
    expect(screen.getByText('scout')).toBeTruthy();
  });

  it('labels the leader by its display name rather than its id', async () => {
    liveSession({ agents: [agent({ id: 'leader', status: 'streaming', partialText: 'x' })] });
    await mount();
    // The leader gets the product name, not the literal id.
    expect(screen.queryByText('leader')).toBeNull();
  });

  it('falls back to any agent with partial text when none is streaming', async () => {
    liveSession({
      agents: [agent({ id: 'sa1', name: 'scout', status: 'idle', partialText: 'left over' })],
    });
    await mount();
    expect(screen.getByText(/left over/)).toBeTruthy();
  });

  it('refetches when the activity fingerprint changes', async () => {
    liveSession({ agents: [agent({ toolCalls: 1 })] });
    await mount();
    const before = urls().filter((u) => u.includes('/events')).length;

    await act(async () => {
      liveSession({ agents: [agent({ toolCalls: 2 })] });
    });
    await waitFor(() =>
      expect(urls().filter((u) => u.includes('/events')).length).toBeGreaterThan(before),
    );
  });
});

describe('mailbox thread', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    from: 'human',
    to: 'leader',
    type: 'steer',
    subject: 's',
    body: 'do the thing',
    priority: 'high',
    readByLeader: null,
    readByCount: 0,
    completed: false,
    outcome: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    fromLeader: false,
    ...overrides,
  });

  it('renders nothing when the thread is empty', async () => {
    await mount();
    expect(screen.queryByText('do the thing')).toBeNull();
  });

  it('renders a sent message as delivered', async () => {
    routes.mailbox = { thread: [message()] };
    await mount();
    await waitFor(() => expect(screen.getByText('do the thing')).toBeTruthy());
  });

  it('marks a read message differently from an unread one', async () => {
    routes.mailbox = { thread: [message({ readByLeader: '2026-01-01T00:01:00.000Z' })] };
    await mount();
    await waitFor(() => expect(screen.getByText('do the thing')).toBeTruthy());
  });

  it('marks a completed message as done', async () => {
    routes.mailbox = { thread: [message({ completed: true })] };
    await mount();
    await waitFor(() => expect(screen.getByText('do the thing')).toBeTruthy());
  });

  it('renders an agent reply without a delivery status', async () => {
    routes.mailbox = { thread: [message({ id: 'm2', fromLeader: true, body: 'on it' })] };
    await mount();
    await waitFor(() => expect(screen.getByText('on it')).toBeTruthy());
  });

  it('shows only the last six messages', async () => {
    routes.mailbox = {
      thread: Array.from({ length: 10 }, (_, i) => message({ id: `m${i}`, body: `body-${i}` })),
    };
    await mount();

    await waitFor(() => expect(screen.getByText('body-9')).toBeTruthy());
    expect(screen.queryByText('body-0')).toBeNull();
  });

  it('ignores a non-array thread payload', async () => {
    routes.mailbox = { thread: 'nope' };
    await mount();
    expect(screen.queryByText('do the thing')).toBeNull();
  });

  it('swallows a failing mailbox fetch — the thread is supplementary', async () => {
    routes.mailbox = new Error('boom');
    await mount();
    // The event stream still renders; no error line for the mailbox.
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('swallows a non-ok mailbox response', async () => {
    routes.mailbox = undefined;
    await mount();
    expect(screen.queryByText(/404/)).toBeNull();
  });
});

describe('composer', () => {
  function textarea(): HTMLTextAreaElement {
    return screen.getByRole('textbox') as HTMLTextAreaElement;
  }

  function sendButton(): HTMLButtonElement {
    const buttons = screen.getAllByRole('button');
    return buttons.at(-1) as HTMLButtonElement;
  }

  it('disables send while the draft is empty', async () => {
    await mount();
    expect(sendButton().disabled).toBe(true);
  });

  it('disables send for a whitespace-only draft', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: '   ' } });
    expect(sendButton().disabled).toBe(true);
  });

  it('posts the draft with the selected type and priority', async () => {
    await mount();
    const [typeSelect, prioritySelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(typeSelect!, { target: { value: 'ask' } });
    fireEvent.change(prioritySelect!, { target: { value: 'low' } });
    fireEvent.change(textarea(), { target: { value: 'what now?' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/message'));
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({
        text: 'what now?',
        type: 'ask',
        priority: 'low',
      });
    });
  });

  it('trims the draft before sending', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: '  padded  ' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/message'));
      expect(JSON.parse((call![1] as { body: string }).body).text).toBe('padded');
    });
  });

  it('clears the draft after a successful send', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('keeps the draft when the send fails', async () => {
    routes.message = { ok: false, status: 503 };
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText(/503/)).toBeTruthy());
    expect(textarea().value).toBe('go');
  });

  it('sends on ctrl+enter', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/message'))).toBe(true),
    );
  });

  it('sends on cmd+enter', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/message'))).toBe(true),
    );
  });

  it('does not send on a bare enter — that is a newline', async () => {
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/message'))).toBe(false);
  });

  it('reports differently depending on whether the target is running', async () => {
    liveSession({ status: 'active' });
    await mount();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/message'))).toBe(true),
    );
    // Both branches render a confirmation line; the wording differs by state.
    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('refreshes the thread after sending', async () => {
    await mount();
    const before = urls().filter((u) => u.includes('/mailbox')).length;
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(urls().filter((u) => u.includes('/mailbox')).length).toBeGreaterThan(before),
    );
  });
});

describe('interrupt', () => {
  beforeEach(() => liveSession({ status: 'active' }));

  it('posts a reason to the interrupt endpoint', async () => {
    await mount();
    fireEvent.click(screen.getByTitle(/Cooperatively stop/i));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/interrupt'));
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as { body: string }).body)).toHaveProperty('reason');
    });
  });

  it('reports a failed interrupt', async () => {
    routes.interrupt = { ok: false, status: 500 };
    await mount();
    fireEvent.click(screen.getByTitle(/Cooperatively stop/i));

    await waitFor(() => expect(screen.getByText(/500/)).toBeTruthy());
  });

  it('refreshes the thread after interrupting', async () => {
    await mount();
    const before = urls().filter((u) => u.includes('/mailbox')).length;
    fireEvent.click(screen.getByTitle(/Cooperatively stop/i));

    await waitFor(() =>
      expect(urls().filter((u) => u.includes('/mailbox')).length).toBeGreaterThan(before),
    );
  });
});

describe('scroll pinning', () => {
  it('tracks whether the reader is pinned to the bottom', async () => {
    routes.events = events([{ ts: '1', role: 'user', text: 'x' }]);
    const { container } = await mount();
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;

    // Scrolled away from the bottom — auto-scroll should stop.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    // Back at the bottom.
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(900);
  });
});

describe('polling', () => {
  it('stops polling while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    const before = urls().length;

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls()).toHaveLength(before);

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(urls().length).toBeGreaterThan(before);
  });

  it('stops fetching after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = await mount();
    unmount();
    const before = urls().length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls()).toHaveLength(before);
  });
});
