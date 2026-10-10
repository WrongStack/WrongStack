import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type WebSocket as ServerSocket,
  WebSocketServer,
  WebSocket as WsWebSocket,
} from 'ws/native';
import {
  type ConnectOptions,
  createHttpClient,
  type RunEvent,
  WrongStackClient,
  WrongStackError,
} from '../src/index.js';

type Frame = { type: string; payload?: Record<string, unknown>; seq?: number };

/**
 * A WebUI server stand-in: announces a session, records what the client
 * sends, and numbers session broadcasts into a log it replays on a
 * reconnect's `session.subscribe`, the way the real server does.
 */
class FakeServer {
  readonly received: Frame[] = [];
  socket: ServerSocket | undefined;
  epoch = 'e1';
  /** Sessions with a run in flight, for `session.run_state`. */
  readonly running = new Set<string>();
  private readonly log = new Map<string, Frame[]>();
  private readonly issued = new Map<string, number>();
  private readonly waiting: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  private constructor(
    readonly http: http.Server,
    readonly wss: WebSocketServer,
    readonly url: string,
  ) {}

  static async start(
    opts: { token?: string; announce?: boolean; httpHandler?: http.RequestListener } = {},
  ): Promise<FakeServer> {
    const server = http.createServer((req, res) => {
      if (opts.httpHandler) return opts.httpHandler(req, res);
      if (req.url?.startsWith('/ws-auth')) {
        const ok = !opts.token || req.headers['x-ws-token'] === opts.token;
        res.writeHead(ok ? 200 : 401).end(ok ? 'ok' : 'Unauthorized');
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({
      server,
      verifyClient: (
        info: { req: http.IncomingMessage },
        done: (ok: boolean, code?: number) => void,
      ) => {
        const token = new URL(info.req.url ?? '/', 'http://x').searchParams.get('token');
        if (opts.token && token !== opts.token) done(false, 401);
        else done(true);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fake = new FakeServer(server, wss, url);
    wss.on('connection', (socket) => {
      fake.socket = socket;
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data)) as Frame;
        fake.received.push(frame);
        if (frame.type === 'session.subscribe') fake.catchUp(frame.payload ?? {});
        const index = fake.waiting.findIndex((w) => w.type === frame.type);
        if (index >= 0) fake.waiting.splice(index, 1)[0]?.resolve(frame);
      });
      if (opts.announce !== false) {
        fake.emit({
          type: 'session.start',
          payload: { sessionId: 'sess_1', provider: 'p', model: 'm', eventEpoch: fake.epoch },
        });
      }
    });
    return fake;
  }

  emit(frame: Frame): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }

  /** A session broadcast: numbered and logged, delivered only if a socket is up. */
  broadcast(frame: Frame): void {
    const sessionId = String(frame.payload?.sessionId);
    const frames = this.log.get(sessionId) ?? [];
    this.log.set(sessionId, frames);
    const seq = (this.issued.get(sessionId) ?? 0) + 1;
    this.issued.set(sessionId, seq);
    const numbered = { ...frame, seq };
    frames.push(numbered);
    this.emit(numbered);
  }

  /** Cut the connection the way a network drop does (no close frame). */
  drop(): void {
    this.socket?.terminate();
  }

  /** A new server process: new epoch, empty log, numbering from 1. */
  restart(): void {
    this.epoch = 'e2';
    this.log.clear();
    this.issued.clear();
  }

  /** The server dropped a session's frames (its log evicted them); numbering goes on. */
  forget(sessionId: string): void {
    this.log.delete(sessionId);
  }

  private catchUp(payload: Record<string, unknown>): void {
    const declared = (payload.sessionIds as string[] | undefined) ?? [];
    const cursors = payload.cursors as Record<string, number> | undefined;
    if (cursors) {
      for (const [sessionId, after] of Object.entries(cursors)) {
        const frames = payload.eventEpoch === this.epoch ? this.log.get(sessionId) : undefined;
        const oldest = frames?.[0]?.seq ?? Number.POSITIVE_INFINITY;
        const covered = frames !== undefined && oldest <= after + 1;
        if (covered)
          for (const frame of frames.filter((f) => (f.seq ?? 0) > after)) this.emit(frame);
        this.emit({ type: 'session.frames_resumed', payload: { sessionId, resumed: covered } });
      }
      for (const sessionId of declared) {
        this.emit({
          type: 'session.run_state',
          payload: { sessionId, isRunning: this.running.has(sessionId) },
        });
      }
    }
  }

  /** The next frame of this type the client sends (or one it already sent). */
  frame(type: string): Promise<Frame> {
    const seen = this.received.find((f) => f.type === type && !this.taken.has(f));
    if (seen) {
      this.taken.add(seen);
      return Promise.resolve(seen);
    }
    return new Promise((resolve) =>
      this.waiting.push({
        type,
        resolve: (f) => {
          this.taken.add(f);
          resolve(f);
        },
      }),
    );
  }
  private readonly taken = new Set<Frame>();

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

let server: FakeServer | undefined;
let client: WrongStackClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await server?.stop();
  server = undefined;
});

async function connected(
  opts: Parameters<typeof FakeServer.start>[0] = {},
  clientOptions: Partial<ConnectOptions> = {},
) {
  server = await FakeServer.start(opts);
  client = await WrongStackClient.connect({
    url: server.url,
    ...(opts.token ? { token: opts.token } : {}),
    timeoutMs: 2_000,
    ...clientOptions,
  });
  return { server, client };
}

describe('WrongStackClient', () => {
  it('connects with the token, adopts the announced session and subscribes to it', async () => {
    const { server, client } = await connected({ token: 't0k' });
    expect(client.sessionId).toBe('sess_1');
    expect(client.session.model).toBe('m');
    const subscribe = await server.frame('session.subscribe');
    expect(subscribe.payload?.sessionIds).toEqual(['sess_1']);
  });

  it('works with the ws package as the socket class', async () => {
    server = await FakeServer.start();
    client = await WrongStackClient.connect({ url: server.url, WebSocket: WsWebSocket });
    expect(client.sessionId).toBe('sess_1');
  });

  it('streams a run in order and settles with the server result', async () => {
    const { server, client } = await connected();
    const run = client.send('hello');
    const sent = await server.frame('user_message');
    expect(sent.payload).toMatchObject({ id: run.id, content: 'hello', sessionId: 'sess_1' });
    server.emit({
      type: 'provider.text_delta',
      payload: { text: 'Hi ', messageId: 'a', sessionId: 'sess_1' },
    });
    server.emit({ type: 'tool.started', payload: { id: 't1', name: 'bash', sessionId: 'sess_1' } });
    server.emit({
      type: 'provider.text_delta',
      payload: { text: 'there', messageId: 'a', sessionId: 'sess_1' },
    });
    server.emit({
      type: 'run.result',
      payload: { requestId: run.id, status: 'done', iterations: 2, sessionId: 'sess_1' },
    });
    const seen: RunEvent['type'][] = [];
    for await (const event of run) seen.push(event.type);
    expect(seen).toEqual(['provider.text_delta', 'tool.started', 'provider.text_delta']);
    const result = await run.result;
    expect(result).toMatchObject({ status: 'done', iterations: 2, text: 'Hi there' });
    expect(result.error).toBeUndefined();
    await expect(run.text()).resolves.toBe('Hi there');
  });

  it('reports a run that did not finish as a result carrying the error', async () => {
    const { server, client } = await connected();
    const failed = client.send('a');
    await server.frame('user_message');
    server.emit({
      type: 'run.result',
      payload: {
        requestId: failed.id,
        status: 'failed',
        iterations: 1,
        error: { code: 'provider_down', message: 'boom', recoverable: true },
      },
    });
    const result = await failed.result;
    expect(result.error).toBeInstanceOf(WrongStackError);
    expect(result.error?.toJSON()).toEqual({
      kind: 'run',
      code: 'provider_down',
      detail: 'boom',
      retryable: true,
    });
    await expect(failed.text()).rejects.toMatchObject({ kind: 'run' });

    const aborted = client.send('b');
    await server.frame('user_message');
    aborted.abort();
    expect((await server.frame('abort')).payload).toEqual({ sessionId: 'sess_1' });
    server.emit({
      type: 'run.result',
      payload: { requestId: aborted.id, status: 'aborted', iterations: 0 },
    });
    expect((await aborted.result).error?.kind).toBe('aborted');
  });

  it('fails the pending run on a refused turn and ignores unrelated errors', async () => {
    const { server, client } = await connected();
    const run = client.send('x');
    await server.frame('user_message');
    server.emit({
      type: 'error',
      payload: { phase: 'mcp.list', message: 'unrelated', sessionId: 'sess_1' },
    });
    server.emit({
      type: 'error',
      payload: {
        phase: 'user_message',
        code: 'session_not_ready',
        message: 'Session sess_1 is not open',
        sessionId: 'sess_1',
      },
    });
    await expect(run.result).rejects.toMatchObject({
      kind: 'server',
      code: 'session_not_ready',
      retryable: true,
    });
  });

  it('pins a busy refusal on the prompt just sent, not on the run still going', async () => {
    const { server, client } = await connected();
    const running = client.send('first');
    await server.frame('user_message');
    const refused = client.send('second');
    await server.frame('user_message');
    server.emit({
      type: 'error',
      payload: {
        phase: 'user_message',
        message: 'Agent is already processing a request. Wait for the current run to finish.',
        sessionId: 'sess_1',
      },
    });
    await expect(refused.result).rejects.toMatchObject({ kind: 'server', retryable: true });
    server.emit({
      type: 'provider.text_delta',
      payload: { text: 'ok', messageId: 'a', sessionId: 'sess_1' },
    });
    server.emit({
      type: 'run.result',
      payload: { requestId: running.id, status: 'done', iterations: 1, sessionId: 'sess_1' },
    });
    expect(await running.result).toMatchObject({ status: 'done', text: 'ok' });
  });

  it('answers confirmations through the handler or by hand', async () => {
    server = await FakeServer.start();
    const asked: string[] = [];
    client = await WrongStackClient.connect({
      url: server.url,
      onConfirm: (request) => {
        asked.push(request.toolName);
        return request.toolName === 'read' ? 'yes' : undefined;
      },
    });
    const run = client.send('go');
    await server.frame('user_message');
    const events: RunEvent[] = [];
    run.onEvent((event) => events.push(event));
    const confirm = (id: string, toolName: string) =>
      server?.emit({
        type: 'tool.confirm_needed',
        payload: { id, toolName, input: {}, suggestedPattern: toolName, sessionId: 'sess_1' },
      });
    confirm('c1', 'read');
    expect((await server.frame('tool.confirm_result')).payload).toEqual({
      id: 'c1',
      decision: 'yes',
      sessionId: 'sess_1',
    });
    confirm('c2', 'bash');
    await expect.poll(() => events.length).toBe(2);
    run.confirm('c2', 'no');
    expect((await server.frame('tool.confirm_result')).payload).toMatchObject({
      id: 'c2',
      decision: 'no',
    });
    expect(asked).toEqual(['read', 'bash']);
  });

  it('lists, opens and resumes sessions', async () => {
    const { server, client } = await connected();
    const listing = client.listSessions(5);
    expect((await server.frame('sessions.list')).payload).toMatchObject({ limit: 5 });
    server.emit({
      type: 'sessions.list',
      payload: {
        sessions: [
          {
            id: 'sess_0',
            title: 'old',
            startedAt: 't',
            model: 'm',
            provider: 'p',
            tokenTotal: 1,
            isCurrent: false,
          },
        ],
      },
    });
    expect((await listing).map((s) => s.id)).toEqual(['sess_0']);

    const opened = client.newSession();
    await server.frame('session.new');
    // A re-announcement of a known session is not the answer.
    server.emit({
      type: 'session.start',
      payload: { sessionId: 'sess_1', provider: 'p', model: 'm2' },
    });
    server.emit({
      type: 'session.start',
      payload: { sessionId: 'sess_2', provider: 'p', model: 'm' },
    });
    expect((await opened).sessionId).toBe('sess_2');
    expect(client.sessionId).toBe('sess_2');

    const resumed = client.resumeSession('sess_0');
    expect((await server.frame('session.resume')).payload).toMatchObject({ id: 'sess_0' });
    server.emit({
      type: 'session.start',
      payload: {
        sessionId: 'sess_0',
        provider: 'p',
        model: 'm',
        replayMessages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect((await resumed).replayMessages).toHaveLength(1);
    const lastSubscription = () =>
      server.received.filter((f) => f.type === 'session.subscribe').at(-1)?.payload?.sessionIds;
    await expect.poll(lastSubscription).toEqual(['sess_0', 'sess_2', 'sess_1']);
  });

  it('delivers typed and untyped frames to listeners and sends any frame', async () => {
    const { server, client } = await connected();
    const deltas: string[] = [];
    const other: unknown[] = [];
    client.on('provider.text_delta', (payload) => deltas.push(payload.text));
    const off = client.on('custom.thing', (payload) => other.push(payload));
    server.emit({ type: 'provider.text_delta', payload: { text: 'x', messageId: 'a' } });
    server.emit({ type: 'custom.thing', payload: { n: 1 } });
    await expect.poll(() => other.length).toBe(1);
    off();
    server.emit({ type: 'custom.thing', payload: { n: 2 } });
    client.post({ type: 'mcp.list', payload: {} });
    await server.frame('mcp.list');
    expect(deltas).toEqual(['x']);
    expect(other).toEqual([{ n: 1 }]);
  });

  it('fails pending runs when the connection drops and reconnecting is off', async () => {
    const { server, client } = await connected({}, { reconnect: false });
    const closed: unknown[] = [];
    client.onClose((error) => closed.push(error));
    const run = client.send('x');
    await server.frame('user_message');
    server.socket?.close(1011, 'server restart');
    await expect(run.result).rejects.toMatchObject({ kind: 'connection', code: '1011' });
    expect(closed[0]).toMatchObject({ kind: 'connection', detail: 'server restart' });
    expect(() => client.post({ type: 'ping' })).toThrow(WrongStackError);
    await expect(client.send('late').result).rejects.toMatchObject({ kind: 'connection' });
  });

  it('keeps a run through a dropped connection and catches up on what it missed', async () => {
    const { server, client } = await connected({}, { reconnect: { initialDelayMs: 300 } });
    const states: string[] = [];
    client.onStateChange((state) => states.push(state));
    const run = client.send('hello');
    const texts: string[] = [];
    run.onEvent((event) => {
      if (event.type === 'provider.text_delta') texts.push(event.payload.text);
    });
    const id = (await server.frame('user_message')).payload?.id;
    server.running.add('sess_1');
    server.broadcast({
      type: 'provider.text_delta',
      payload: { text: 'Hi ', messageId: 'a', sessionId: 'sess_1' },
    });
    await expect.poll(() => texts.length).toBe(1);

    server.drop();
    await expect.poll(() => client.state).toBe('reconnecting');
    expect(() => client.post({ type: 'ping' })).toThrow(/reconnecting/);
    // Broadcast while no socket is up: only the log has these.
    server.broadcast({
      type: 'provider.text_delta',
      payload: { text: 'there', messageId: 'a', sessionId: 'sess_1' },
    });
    server.running.delete('sess_1');
    server.broadcast({
      type: 'run.result',
      payload: { requestId: id, status: 'done', iterations: 1, sessionId: 'sess_1' },
    });

    const result = await run.result;
    expect(result).toMatchObject({ status: 'done', text: 'Hi there' });
    expect(texts).toEqual(['Hi ', 'there']);
    const resubscribe = server.received.filter((f) => f.type === 'session.subscribe').at(-1);
    expect(resubscribe?.payload).toMatchObject({ cursors: { sess_1: 1 }, eventEpoch: 'e1' });
    expect(states).toEqual(['reconnecting', 'open']);
    // A frame the catch-up already delivered is not applied twice.
    const seen: string[] = [];
    client.on('provider.text_delta', (payload) => seen.push(payload.text));
    server.emit({
      type: 'provider.text_delta',
      seq: 2,
      payload: { text: 'there', messageId: 'a', sessionId: 'sess_1' },
    });
    server.broadcast({
      type: 'provider.text_delta',
      payload: { text: 'next', messageId: 'b', sessionId: 'sess_1' },
    });
    await expect.poll(() => seen).toEqual(['next']);
  });

  it('fails a run in flight when the server restarted', async () => {
    const { server, client } = await connected({}, { reconnect: { initialDelayMs: 20 } });
    const run = client.send('x');
    await server.frame('user_message');
    server.running.add('sess_1');
    server.drop();
    server.restart();
    await expect(run.result).rejects.toMatchObject({
      kind: 'connection',
      code: 'server_restarted',
    });
    await expect.poll(() => client.state).toBe('open');
    const resubscribe = server.received.filter((f) => f.type === 'session.subscribe').at(-1);
    expect(resubscribe?.payload).not.toHaveProperty('cursors');
  });

  it('reports a result that ended while disconnected and left the server log', async () => {
    const { server, client } = await connected({}, { reconnect: { initialDelayMs: 20 } });
    const run = client.send('x');
    const id = (await server.frame('user_message')).payload?.id;
    const texts: string[] = [];
    run.onEvent((event) => {
      if (event.type === 'provider.text_delta') texts.push(event.payload.text);
    });
    server.broadcast({
      type: 'provider.text_delta',
      payload: { text: 'a', messageId: 'a', sessionId: 'sess_1' },
    });
    await expect.poll(() => texts.length).toBe(1);
    server.drop();
    server.broadcast({
      type: 'run.result',
      payload: { requestId: id, status: 'done', iterations: 1, sessionId: 'sess_1' },
    });
    server.forget('sess_1');
    await expect(run.result).rejects.toMatchObject({ kind: 'connection', code: 'result_lost' });
  });

  it('keeps a run that is still going when its frames could not be caught up', async () => {
    const { server, client } = await connected({}, { reconnect: { initialDelayMs: 20 } });
    const run = client.send('x');
    const id = (await server.frame('user_message')).payload?.id;
    server.running.add('sess_1');
    const texts: string[] = [];
    run.onEvent((event) => {
      if (event.type === 'provider.text_delta') texts.push(event.payload.text);
    });
    server.broadcast({
      type: 'provider.text_delta',
      payload: { text: 'a', messageId: 'a', sessionId: 'sess_1' },
    });
    await expect.poll(() => texts.length).toBe(1);
    server.drop();
    server.forget('sess_1');
    await expect.poll(() => client.state).toBe('open');
    const subscribes = () => server.received.filter((f) => f.type === 'session.subscribe').length;
    await expect.poll(subscribes).toBe(2);
    expect(run.done).toBe(false);
    server.broadcast({
      type: 'run.result',
      payload: {
        requestId: id,
        status: 'done',
        iterations: 1,
        finalText: 'end',
        sessionId: 'sess_1',
      },
    });
    await expect(run.text()).resolves.toBe('end');
  });

  it('gives up after its attempts and closes with the last error', async () => {
    const { server, client } = await connected(
      {},
      { reconnect: { attempts: 2, initialDelayMs: 10 }, timeoutMs: 500 },
    );
    const closed: unknown[] = [];
    client.onClose((error) => closed.push(error));
    const run = client.send('x');
    await server.frame('user_message');
    await server.stop();
    await expect(run.result).rejects.toMatchObject({ kind: 'connection', code: 'unreachable' });
    expect(client.state).toBe('closed');
    expect(closed[0]).toMatchObject({ kind: 'connection', code: 'unreachable' });
  });

  it('stops reconnecting when closed', async () => {
    const { server, client } = await connected({}, { reconnect: { initialDelayMs: 200 } });
    const closed: unknown[] = [];
    client.onClose((error) => closed.push(error));
    server.drop();
    await expect.poll(() => client.state).toBe('reconnecting');
    client.close();
    expect(client.state).toBe('closed');
    expect(closed).toEqual([undefined]);
    const subscribes = () => server.received.filter((f) => f.type === 'session.subscribe').length;
    const before = subscribes();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subscribes()).toBe(before);
  });

  // The reply waiter used to be armed before the post: when the post threw
  // (closed / reconnecting) the caller got that error, and the orphaned waiter
  // rejected again at its timeout with nobody listening — an unhandled
  // rejection, fatal to a default Node process.
  it('leaves no unobserved rejection when a request cannot be sent', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      server = await FakeServer.start();
      client = await WrongStackClient.connect({
        url: server.url,
        timeoutMs: 100,
        reconnect: false,
      });
      const closed = new Promise<void>((resolve) => client?.onClose(() => resolve()));
      server.drop();
      await closed;
      await expect(client.listSessions()).rejects.toMatchObject({ kind: 'connection' });
      await expect(client.newSession()).rejects.toMatchObject({ kind: 'connection' });
      await expect(client.resumeSession('sess_0')).rejects.toMatchObject({ kind: 'connection' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('times out a request the server never answers', async () => {
    server = await FakeServer.start();
    client = await WrongStackClient.connect({ url: server.url, timeoutMs: 150 });
    await expect(client.listSessions()).rejects.toMatchObject({
      kind: 'timeout',
      code: 'no_answer',
    });
  });

  it('tells a refused token from an unreachable server', async () => {
    server = await FakeServer.start({ token: 'right' });
    await expect(
      WrongStackClient.connect({ url: server.url, token: 'wrong', timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ kind: 'auth', code: '401' });
    const port = (server.http.address() as AddressInfo).port;
    await server.stop();
    server = undefined;
    await expect(
      WrongStackClient.connect({ url: `http://127.0.0.1:${port}`, timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ kind: 'connection', code: 'unreachable' });
  });
});

describe('createHttpClient', () => {
  it('calls the session routes with the token and maps refusals to the error model', async () => {
    const seen: Array<{
      method: string | undefined;
      url: string | undefined;
      token: unknown;
      body: string;
    }> = [];
    server = await FakeServer.start({
      announce: false,
      httpHandler: (req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, token: req.headers['x-ws-token'], body });
          res.setHeader('Content-Type', 'application/json');
          if (req.url === '/api/sessions') res.end('[]');
          else if (req.url?.startsWith('/api/sessions/sess_1/message')) {
            res.end(
              JSON.stringify({ ok: true, id: 'm', to: 'x', type: 'steer', delivered: 'active' }),
            );
          } else res.writeHead(404).end(JSON.stringify({ error: 'Session not found' }));
        });
      },
    });
    const api = createHttpClient({ url: server.url, token: 'tk' });
    expect(await api.listLiveSessions()).toEqual([]);
    expect((await api.messageSession('sess_1', { text: 'steer this' })).delivered).toBe('active');
    await expect(api.sessionEvents('nope', 10)).rejects.toMatchObject({
      kind: 'not_found',
      code: '404',
      detail: 'Session not found',
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/sessions',
      'POST /api/sessions/sess_1/message',
      'GET /api/sessions/nope/events?limit=10',
    ]);
    expect(seen.every((s) => s.token === 'tk')).toBe(true);
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ text: 'steer this' });
  });
});
