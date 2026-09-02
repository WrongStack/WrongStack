import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BaseHTTPTransport,
  createTimeoutSignal,
  type HttpTransportOptions,
  makeAbortError,
} from '../src/transport-base.js';

const originalFetch = globalThis.fetch;
const originalUnsafeTls = process.env['WRONGSTACK_UNSAFE_MCP_TLS'];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUnsafeTls === undefined) delete process.env['WRONGSTACK_UNSAFE_MCP_TLS'];
  else process.env['WRONGSTACK_UNSAFE_MCP_TLS'] = originalUnsafeTls;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class TestTransport extends BaseHTTPTransport {
  constructor(options: HttpTransportOptions) {
    super(options, 'test');
  }

  protected genId(): number {
    return 1;
  }

  fetchAuthorized(input: string | URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    return this.fetchWithAuthorization(input, init, signal);
  }

  setProtocolVersion(value: string): void {
    this.protocolVersion = value;
  }

  setMetadata(): void {
    this.serverMetadata = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    };
  }

  fireNotifications(): void {
    this.notifyDisconnect();
    this.notifyResourcesChanged();
    this.notifyPromptsChanged();
  }

  applyAgent(init: RequestInit): void {
    this.applyTlsAgent(init);
  }
}

describe('BaseHTTPTransport helpers', () => {
  it('creates named abort errors', () => {
    expect(makeAbortError('tools/list')).toMatchObject({
      name: 'AbortError',
      message: 'MCP request "tools/list" aborted by client',
    });
  });

  it('propagates an already-aborted parent signal', () => {
    const parent = new AbortController();
    parent.abort('stop');
    const timeout = createTimeoutSignal(parent.signal, 1_000);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBe('stop');
    timeout.dispose();
  });

  it('propagates later parent cancellation and timeout cancellation', () => {
    const parent = new AbortController();
    const timeout = createTimeoutSignal(parent.signal, 1_000);
    parent.abort('later');
    expect(timeout.signal.reason).toBe('later');
    timeout.dispose();

    vi.useFakeTimers();
    const timed = createTimeoutSignal(undefined, 25);
    vi.advanceTimersByTime(25);
    expect(timed.signal.reason).toMatchObject({
      message: 'MCP HTTP request timed out after 25ms',
    });
    timed.dispose();
  });

  it('returns defensive tool and metadata snapshots', () => {
    const transport = new TestTransport({ name: 'base', url: 'https://example.test' });
    expect(transport.listTools()).toEqual([]);
    expect(transport.getServerMetadata()).toBeUndefined();
    transport.setMetadata();
    const first = transport.getServerMetadata();
    const second = transport.getServerMetadata();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.capabilities).not.toBe(second?.capabilities);
    expect(first?.serverInfo).not.toBe(second?.serverInfo);
  });

  it('subscribes, unsubscribes, and isolates notification handler failures', () => {
    const transport = new TestTransport({ name: 'base', url: 'https://example.test' });
    const disconnect = vi.fn();
    const resources = vi.fn();
    const prompts = vi.fn();
    transport.onDisconnect(() => {
      throw new Error('disconnect');
    });
    const offDisconnect = transport.onDisconnect(disconnect);
    const offResources = transport.onResourcesChanged(resources);
    transport.onResourcesChanged(() => {
      throw new Error('resources');
    });
    const offPrompts = transport.onPromptsChanged(prompts);
    transport.onPromptsChanged(() => {
      throw new Error('prompts');
    });

    transport.fireNotifications();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(resources).toHaveBeenCalledOnce();
    expect(prompts).toHaveBeenCalledOnce();

    offDisconnect();
    offDisconnect();
    offResources();
    offPrompts();
    transport.fireNotifications();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(resources).toHaveBeenCalledOnce();
    expect(prompts).toHaveBeenCalledOnce();
  });

  it('applies an explicitly configured TLS agent', () => {
    process.env['WRONGSTACK_UNSAFE_MCP_TLS'] = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      tls: { ca: 'certificate', rejectUnauthorized: false },
    });
    const init: RequestInit = {};
    transport.applyAgent(init);
    expect(init.dispatcher).toBeDefined();

    const verifiedTransport = new TestTransport({
      name: 'verified',
      url: 'https://example.test',
      tls: { rejectUnauthorized: true },
    });
    const verifiedInit: RequestInit = {};
    verifiedTransport.applyAgent(verifiedInit);
    expect(verifiedInit.dispatcher).toBeDefined();
  });

  it('rejects disabled TLS verification without the explicit opt-in', () => {
    delete process.env['WRONGSTACK_UNSAFE_MCP_TLS'];
    expect(
      () =>
        new TestTransport({
          name: 'base',
          url: 'https://example.test',
          tls: { rejectUnauthorized: false },
        }),
    ).toThrow(/WRONGSTACK_UNSAFE_MCP_TLS=1/);
  });

  it('adds protocol and bearer headers without retrying successful responses', async () => {
    const getAccessToken = vi.fn(async () => ({
      accessToken: 'secret',
      tokenType: 'Bearer',
      resource: 'https://example.test/',
    }));
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      authorizationProvider: { getAccessToken },
    });
    transport.setProtocolVersion('2025-06-18');
    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer secret');
      expect(headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
      return new Response('ok');
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it('returns the challenge response when the authorization provider declines a retry', async () => {
    const handleUnauthorized = vi.fn(async () => false);
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      authorizationProvider: {
        getAccessToken: vi.fn(async () => undefined),
        handleUnauthorized,
      },
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer scope="tools:read"' },
      });
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 401,
    });
    expect(handleUnauthorized).toHaveBeenCalledOnce();
  });

  it('retries after authorization and tolerates body cancellation failure', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      authorizationProvider: {
        getAccessToken: vi.fn(async () => undefined),
        handleUnauthorized: vi.fn(async () => true),
      },
    });
    const cancel = vi.fn(async () => {
      throw new Error('already closed');
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 401,
        headers: new Headers({ 'www-authenticate': 'Bearer' }),
        body: { cancel },
      } as unknown as Response)
      .mockResolvedValueOnce(new Response('ok'));

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the redirect response when the Location header is missing', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response('moved', { status: 302 }); // no Location header
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 302,
    });
    // A redirect with no target is returned as-is rather than followed.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a URL object as the request target', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
    });
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(String(input));
      return new Response('ok');
    });

    await expect(
      transport.fetchAuthorized(new URL('https://example.test/tools'), {}),
    ).resolves.toMatchObject({ status: 200 });
    // The non-string input branch normalizes the URL object (transport-base.ts:171).
    expect(seen[0]).toBe('https://example.test/tools');
  });

  it('follows same-origin redirects and keeps the Authorization header', async () => {
    const token = ['Bearer', 'fixture-token'].join(' ');
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      authorizationProvider: {
        getAccessToken: vi.fn(async () => ({
          accessToken: 'fixture-token',
          tokenType: 'Bearer',
          resource: 'https://example.test/',
        })),
      },
    });
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      if (seen.length === 1) {
        return new Response('moved', {
          status: 307,
          headers: { location: 'https://example.test/next' },
        });
      }
      return new Response('ok');
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(seen[1]!.get('Authorization')).toBe(token);
  });

  it('drops the Authorization header when a redirect crosses origins', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
      authorizationProvider: {
        getAccessToken: vi.fn(async () => ({
          accessToken: 'fixture-token',
          tokenType: 'Bearer',
          resource: 'https://example.test/',
        })),
      },
    });
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      if (seen.length === 1) {
        return new Response('moved', {
          status: 308,
          headers: { location: 'https://other.test/landing' },
        });
      }
      return new Response('ok');
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(seen[0]!.get('Authorization')).toBe(['Bearer', 'fixture-token'].join(' '));
    expect(seen[1]!.get('Authorization')).toBeNull();
  });

  it('tolerates body cancellation failure while following a redirect', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
    });
    const cancel = vi.fn(async () => {
      throw new Error('stream already closed');
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: 'https://example.test/next' }),
        body: { cancel },
      } as unknown as Response)
      .mockResolvedValueOnce(new Response('ok'));

    await expect(transport.fetchAuthorized('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a ConfigError once the redirect limit is exceeded', async () => {
    const transport = new TestTransport({
      name: 'base',
      url: 'https://example.test',
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response('moved', {
        status: 302,
        headers: { location: 'https://example.test/hop' },
      });
    });

    await expect(transport.fetchAuthorized('https://example.test', {})).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('exceeded 5 redirects'),
    });
    // The loop performs exactly MAX_TRANSPORT_REDIRECTS hops before throwing.
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });
});
