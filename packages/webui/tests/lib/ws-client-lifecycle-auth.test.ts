import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The socket lifecycle paths the reconnect suite doesn't drive: the
 * `ensureAuthCookie` bootstrap, the 30s connect timeout, a rejected inbound
 * frame, handler isolation in `emit`, and the `retryNow` / constructor-throw
 * branches.
 */

interface FakeWS {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  binaryType: string;
  sent: string[];
  closed: boolean;
}

const FakeWSModule = vi.hoisted(() => {
  const instances: FakeWS[] = [];
  /** When set, the next `new WebSocket()` throws this instead of constructing. */
  const control = { throwOnConstruct: null as Error | null, throwOnClose: false };
  const klass = class FakeWS {
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    binaryType = 'arraybuffer';
    sent: string[] = [];
    closed = false;
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    close: (code?: number, reason?: string) => void = () => {};
    send: (data: string) => void = () => {};
    constructor(url: string) {
      if (control.throwOnConstruct) throw control.throwOnConstruct;
      this.url = url;
      const self = this;
      self.sent = [];
      self.closed = false;
      self.close = (code?: number, reason?: string) => {
        if (control.throwOnClose) throw new Error('already closing');
        self.closed = true;
        self.readyState = 3;
      };
      self.send = (data: string) => {
        self.sent.push(data);
      };
      instances.push(self);
    }
  };
  return { instances, klass, control };
});

vi.stubGlobal('WebSocket', FakeWSModule.klass);

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

const { WrongStackWebSocketClient } = await import('../../src/lib/ws-client');

const URL_ = 'ws://127.0.0.1:3456';

function instances(): FakeWS[] {
  return FakeWSModule.instances;
}

function last(): FakeWS {
  const ws = instances().at(-1);
  expect(ws, 'no socket was constructed').toBeDefined();
  return ws!;
}

/** Open the newest socket, resolving the pending connect(). */
function open() {
  const ws = last();
  ws.readyState = 1;
  ws.onopen?.();
}

function clearCookies() {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    // jsdom has no CookieStore and the SUT reads document.cookie directly,
    // so this is the only way to set up the cookie fixtures.
    // biome-ignore lint/suspicious/noDocumentCookie: see above
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

beforeEach(() => {
  instances().length = 0;
  FakeWSModule.control.throwOnConstruct = null;
  FakeWSModule.control.throwOnClose = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as never);
  clearCookies();
  history.pushState(null, '', '/');
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureAuthCookie', () => {
  it('does nothing when there is no token anywhere', async () => {
    const client = new WrongStackWebSocketClient(URL_);
    await client.ensureAuthCookie();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges a token from the ws url for a cookie and strips it', async () => {
    const client = new WrongStackWebSocketClient(`${URL_}/?token=abc123`);
    await client.ensureAuthCookie();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/ws-auth?token=abc123');
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });

    // The token is gone from the url the socket will actually dial. The
    // connect promise stays pending (nothing opens the fake socket) — the
    // url is readable as soon as the socket is constructed.
    void client.connect().catch(() => {});
    await vi.waitFor(() => expect(instances()).toHaveLength(1));
    expect(last().url).not.toContain('token=');
  });

  it('reads the token from the page url when the ws url has none', async () => {
    history.pushState(null, '', '/?token=frompage');
    const client = new WrongStackWebSocketClient(URL_);
    await client.ensureAuthCookie();

    expect(String(fetchMock.mock.calls[0]![0])).toContain('token=frompage');
  });

  it('logs but does not throw when the exchange is rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as never);
    const client = new WrongStackWebSocketClient(`${URL_}/?token=abc`);

    await expect(client.ensureAuthCookie()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('logs but does not throw when the exchange fails at the network level', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const client = new WrongStackWebSocketClient(`${URL_}/?token=abc`);

    await expect(client.ensureAuthCookie()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('short-circuits when the cookie is already present', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: see clearCookies above.
    document.cookie = 'ws_token=already; path=/';
    const client = new WrongStackWebSocketClient(`${URL_}/?token=abc`);
    await client.ensureAuthCookie();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the token in a cross-host ws url — the cookie will not be sent there', async () => {
    // The cookie is scoped to the page origin; a socket on a different host
    // never receives it, so stripping the token would break auth entirely.
    // biome-ignore lint/suspicious/noDocumentCookie: see clearCookies above.
    document.cookie = 'ws_token=already; path=/';
    const client = new WrongStackWebSocketClient('ws://elsewhere.test:3456/?token=keepme');
    await client.ensureAuthCookie();

    void client.connect().catch(() => {});
    await vi.waitFor(() => expect(instances()).toHaveLength(1));
    expect(last().url).toContain('token=keepme');
  });
});

describe('connect timeout', () => {
  it('rejects, closes the orphaned socket and schedules a reconnect', async () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient(URL_);
    // The catch has to be attached before the timers advance: the rejection
    // settles during advanceTimersByTimeAsync, and a handler attached after
    // that point registers as an unhandled rejection.
    const pending = client.connect().catch((err: Error) => err);
    // Let ensureAuthCookie's microtasks settle so the socket exists.
    await vi.advanceTimersByTimeAsync(0);

    const ws = last();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toMatchObject({ message: 'Connection timeout' });
    expect(ws.closed).toBe(true);
    expect(client.status.state).not.toBe('open');
    client.disconnect();
  });

  it('tolerates a close() that throws because the socket is already closing', async () => {
    vi.useFakeTimers();
    FakeWSModule.control.throwOnClose = true;
    const client = new WrongStackWebSocketClient(URL_);
    const pending = client.connect().catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toMatchObject({ message: 'Connection timeout' });
    client.disconnect();
  });

  it('does not fire once the socket is open', async () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient(URL_);
    const pending = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    open();
    await pending;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.status.state).toBe('open');
  });
});

describe('constructor failure', () => {
  it('rejects and reports the error rather than throwing synchronously', async () => {
    FakeWSModule.control.throwOnConstruct = new Error('bad url');
    const client = new WrongStackWebSocketClient('ws://nope');

    const settled = client.connect().catch((err: Error) => err);
    expect(await settled).toMatchObject({ message: 'bad url' });
    expect(client.status).toMatchObject({ state: 'closed', error: 'bad url' });
  });
});

describe('inbound frames', () => {
  async function connected() {
    const client = new WrongStackWebSocketClient(URL_);
    const pending = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    open();
    await pending;
    return client;
  }

  it('dispatches a well-formed frame to its handler', async () => {
    const client = await connected();
    const seen = vi.fn();
    client.on('session.end', seen);

    last().onmessage?.({ data: JSON.stringify({ type: 'session.end', payload: {} }) });
    expect(seen).toHaveBeenCalled();
  });

  it('logs and drops a frame that fails protocol decoding', async () => {
    const client = await connected();
    last().onmessage?.({ data: 'not json at all' });

    expect(console.error).toHaveBeenCalled();
    expect(client.status.state).toBe('open');
  });

  it('a throwing handler does not stop the others', async () => {
    const client = await connected();
    const second = vi.fn();
    client.on('session.end', () => {
      throw new Error('handler blew up');
    });
    client.on('session.end', second);

    last().onmessage?.({ data: JSON.stringify({ type: 'session.end', payload: {} }) });

    expect(second).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('off() detaches a handler', async () => {
    const client = await connected();
    const handler = vi.fn();
    client.on('session.end', handler);
    client.off('session.end', handler);

    last().onmessage?.({ data: JSON.stringify({ type: 'session.end', payload: {} }) });
    expect(handler).not.toHaveBeenCalled();
  });

  it('off() for an event with no handlers is a no-op', async () => {
    const client = await connected();
    expect(() => client.off('never.registered', vi.fn())).not.toThrow();
  });
});

describe('retryNow', () => {
  it('is a no-op while the socket is open', async () => {
    const client = new WrongStackWebSocketClient(URL_);
    const pending = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    open();
    await pending;

    const before = instances().length;
    client.retryNow();
    expect(instances()).toHaveLength(before);
  });

  it('dials again immediately after a close', async () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient(URL_);
    const pending = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    open();
    await pending;

    // The real socket transitions to CLOSED before onclose fires; without
    // this connect() sees a still-OPEN readyState and short-circuits.
    last().readyState = 3;
    last().onclose?.({ code: 1006, reason: 'dropped' });
    const before = instances().length;

    client.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(instances().length).toBeGreaterThan(before);
  });
});
