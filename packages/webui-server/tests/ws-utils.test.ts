import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Mock ws module
vi.mock('ws', () => {
  const MockWebSocket = vi.fn();
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  return { WebSocket: MockWebSocket };
});

import {
  broadcast,
  buildWebUIAccessUrl,
  envFlag,
  errMessage,
  generateAuthToken,
  hostForBrowserUrl,
  resolveAuthToken,
  send,
  sendResult,
  WEBUI_WS_MAX_BUFFERED_BYTES,
} from '../src/server/ws-utils.js';

function connectedClient(ws: WebSocket, sessionId: string, connId: string) {
  return { ws, sessionId, connId, connectedAt: 0 };
}

describe('ws-utils', () => {
  describe('send', () => {
    it('sends JSON stringified message when socket is OPEN', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      send(ws, { type: 'test', payload: { x: 1 } });
      expect(ws.send).toHaveBeenCalledWith('{"type":"test","payload":{"x":1}}');
    });

    it('does nothing when socket is not OPEN', () => {
      const ws = { readyState: WebSocket.CLOSED, send: vi.fn() } as any;
      send(ws, { type: 'test' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does nothing when socket is CLOSING', () => {
      const ws = { readyState: WebSocket.CLOSING, send: vi.fn() } as any;
      send(ws, { type: 'test' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('terminates a slow client before its buffered output can grow further', () => {
      const ws = {
        readyState: WebSocket.OPEN,
        bufferedAmount: WEBUI_WS_MAX_BUFFERED_BYTES,
        send: vi.fn(),
        terminate: vi.fn(),
      } as any;
      send(ws, { type: 'test' });
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.terminate).toHaveBeenCalledOnce();
    });
  });

  describe('broadcast', () => {
    it('sends JSON stringified message to all OPEN clients', () => {
      const ws1 = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      const ws2 = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      const clients = new Map([
        [ws1, connectedClient(ws1, 's1', 'c1')],
        [ws2, connectedClient(ws2, 's2', 'c2')],
      ]);

      broadcast(clients, { type: 'broadcast_test' });

      expect(ws1.send).toHaveBeenCalledWith('{"type":"broadcast_test"}');
      expect(ws2.send).toHaveBeenCalledWith('{"type":"broadcast_test"}');
    });

    it('computes a shared frame size only once for fan-out', () => {
      const byteLength = vi.spyOn(Buffer, 'byteLength');
      const clients = new Map(
        Array.from({ length: 100 }, (_, index) => {
          const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
          return [ws, connectedClient(ws, `s${index}`, `c${index}`)];
        }),
      );

      broadcast(clients, { type: 'large', payload: 'ü'.repeat(10_000) });

      expect(byteLength).toHaveBeenCalledOnce();
      byteLength.mockRestore();
    });

    it('skips clients that are not OPEN', () => {
      const ws1 = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      const ws2 = { readyState: WebSocket.CLOSED, send: vi.fn() } as any;
      const clients = new Map([
        [ws1, connectedClient(ws1, 's1', 'c1')],
        [ws2, connectedClient(ws2, 's2', 'c2')],
      ]);

      broadcast(clients, { type: 'test' });

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('swallows send errors gracefully', () => {
      const ws1 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(() => {
          throw new Error('Send failed');
        }),
      } as any;
      const clients = new Map([[ws1, connectedClient(ws1, 's1', 'c1')]]);

      // Should not throw
      expect(() => broadcast(clients, { type: 'test' })).not.toThrow();
    });

    it('handles empty client map', () => {
      const clients = new Map();
      expect(() => broadcast(clients, { type: 'test' })).not.toThrow();
    });
  });

  describe('sendResult', () => {
    it('sends key.operation_result with success and message', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      sendResult(ws, true, 'Operation completed');

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'key.operation_result',
          payload: { success: true, message: 'Operation completed' },
        }),
      );
    });

    it('sends failure result', () => {
      const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
      sendResult(ws, false, 'Something went wrong');

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'key.operation_result',
          payload: { success: false, message: 'Something went wrong' },
        }),
      );
    });
  });

  describe('errMessage', () => {
    it('returns message from Error instance', () => {
      expect(errMessage(new Error('test error'))).toBe('test error');
    });

    // B-07: migrated from packages/webui/tests/server/ws-utils.test.ts —
    // TypeError (and any other Error subclass) share the `.message` shape
    // the helper reads, but a future refactor that introspects `.name` or
    // walks a non-standard property would break the subclass path. Pinning
    // the bare-subclass behaviour keeps the regression visible.
    it('handles Error subclass', () => {
      expect(errMessage(new TypeError('bad type'))).toBe('bad type');
    });

    it('returns string representation of non-Error values', () => {
      expect(errMessage('direct string')).toBe('direct string');
      expect(errMessage(42)).toBe('42');
      expect(errMessage(null)).toBe('null');
      expect(errMessage({ x: 1 })).toBe('[object Object]');
    });

    // WS-066: this helper feeds `send()` / `broadcast()` payloads, so its
    // output reaches the browser. It used to be the verbatim throw.
    it('redacts a credential quoted back by the thrower', () => {
      const out = errMessage(
        new Error('provider rejected key sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'),
      );
      expect(out).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
      expect(out).toContain('provider rejected key');
    });

    it('rewrites the home directory so the OS account name does not leak', () => {
      const home = homedir();
      const out = errMessage(new Error(`ENOENT: ${home}/projects/app/.env`));
      expect(out).not.toContain(home);
    });

    it('caps the detail length', () => {
      expect(errMessage(new Error('q'.repeat(4000))).length).toBeLessThanOrEqual(500);
    });
  });

  describe('generateAuthToken', () => {
    it('generates a 32-character hex string', () => {
      const token = generateAuthToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique tokens on each call', () => {
      const t1 = generateAuthToken();
      const t2 = generateAuthToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('resolveAuthToken', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env['WEBUI_TOKEN'];
      delete process.env['WEBUI_AUTH_TOKEN'];
    });

    it('uses explicit token when provided', () => {
      const token = resolveAuthToken('explicit-token');
      expect(token).toBe('explicit-token');
    });

    it('falls back to WEBUI_TOKEN env var', () => {
      process.env['WEBUI_TOKEN'] = 'from-webui-token';
      const token = resolveAuthToken();
      expect(token).toBe('from-webui-token');
    });

    it('falls back to WEBUI_AUTH_TOKEN env var', () => {
      process.env['WEBUI_AUTH_TOKEN'] = 'from-auth-token';
      const token = resolveAuthToken();
      expect(token).toBe('from-auth-token');
    });

    it('prefers WEBUI_TOKEN over WEBUI_AUTH_TOKEN', () => {
      process.env['WEBUI_TOKEN'] = 'preferred';
      process.env['WEBUI_AUTH_TOKEN'] = 'fallback';
      const token = resolveAuthToken();
      expect(token).toBe('preferred');
    });

    it('prefers explict token over env vars', () => {
      process.env['WEBUI_TOKEN'] = 'from-env';
      const token = resolveAuthToken('explicit');
      expect(token).toBe('explicit');
    });

    it('generates a random token when nothing is configured', () => {
      const token = resolveAuthToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('trims whitespace from env var values', () => {
      process.env['WEBUI_TOKEN'] = '  trimmed  ';
      const token = resolveAuthToken();
      expect(token).toBe('trimmed');
    });

    it('ignores empty explicit token string', () => {
      process.env['WEBUI_TOKEN'] = 'from-env';
      const token = resolveAuthToken('   ');
      expect(token).toBe('from-env');
    });
  });

  describe('hostForBrowserUrl', () => {
    it('converts 0.0.0.0 to 127.0.0.1', () => {
      expect(hostForBrowserUrl('0.0.0.0')).toBe('127.0.0.1');
    });

    it('converts :: to [::1]', () => {
      expect(hostForBrowserUrl('::')).toBe('[::1]');
    });

    it('converts [::] to [::1]', () => {
      expect(hostForBrowserUrl('[::]')).toBe('[::1]');
    });

    it('wraps IPv6 address in brackets', () => {
      expect(hostForBrowserUrl('::1')).toBe('[::1]');
    });

    it('already-bracketed IPv6 stays bracketed', () => {
      expect(hostForBrowserUrl('[::1]')).toBe('[::1]');
    });

    it('returns IPv4 host unchanged', () => {
      expect(hostForBrowserUrl('192.168.1.1')).toBe('192.168.1.1');
    });

    it('returns hostname unchanged', () => {
      expect(hostForBrowserUrl('localhost')).toBe('localhost');
    });

    it('returns named host unchanged', () => {
      expect(hostForBrowserUrl('my-server.local')).toBe('my-server.local');
    });
  });

  describe('buildWebUIAccessUrl', () => {
    it('builds basic http URL with host and port', () => {
      const url = buildWebUIAccessUrl({ host: '127.0.0.1', port: 3456 });
      expect(url).toBe('http://127.0.0.1:3456');
    });

    it('adds token as query parameter', () => {
      const url = buildWebUIAccessUrl({ host: '127.0.0.1', port: 3456, token: 'abc123' });
      expect(url).toBe('http://127.0.0.1:3456?token=abc123');
    });

    it('uses https protocol when specified', () => {
      const url = buildWebUIAccessUrl({ host: '127.0.0.1', port: 443, protocol: 'https' });
      expect(url).toBe('https://127.0.0.1:443');
    });

    it('uses publicUrl when provided, ignoring host/port', () => {
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        publicUrl: 'https://my-tunnel.example.com',
      });
      expect(url).toBe('https://my-tunnel.example.com');
    });

    it('adds token to publicUrl', () => {
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        token: 'secret',
        publicUrl: 'https://my-tunnel.example.com/path',
      });
      expect(url).toBe('https://my-tunnel.example.com/path?token=secret');
    });

    it('handles publicUrl with existing query parameters', () => {
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        token: 'secret',
        publicUrl: 'https://example.com?existing=true',
      });
      expect(url).toContain('token=secret');
      expect(url).toContain('existing=true');
    });

    // B-07: migrated from packages/webui/tests/server/ws-utils.test.ts —
    // asserts the URL-encoded form of a space-bearing token (`abc 123` →
    // `abc+123`) is preserved in the merged query string. The server's
    // `toContain('token=secret')` does not catch a regression that
    // double-encodes, omits, or leaves the space raw (`abc%20123` would
    // still `toContain('token='` once). The webui variant pins the exact
    // output so a token with whitespace cannot silently break the
    // tunnel URL.
    it('uses publicUrl and preserves existing query params (with URL-encoded space in token)', () => {
      expect(
        buildWebUIAccessUrl({
          host: '127.0.0.1',
          port: 8080,
          token: 'abc 123',
          publicUrl: 'https://wrongstack.example.com/ui?from=tunnel',
        }),
      ).toBe('https://wrongstack.example.com/ui?from=tunnel&token=abc+123');
    });

    it('handles malformed publicUrl gracefully', () => {
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        token: 'secret',
        publicUrl: 'not-a-valid-url',
      });
      // Falls back to appending token with ? or &
      expect(url).toBe('not-a-valid-url?token=secret');
    });

    it('handles IPv6 host conversion', () => {
      const url = buildWebUIAccessUrl({ host: '0.0.0.0', port: 3456 });
      expect(url).toBe('http://127.0.0.1:3456');
    });

    it('handles no token by just returning base', () => {
      const url = buildWebUIAccessUrl({ host: 'localhost', port: 8080 });
      expect(url).toBe('http://localhost:8080');
    });

    it('handles empty publicUrl by ignoring it', () => {
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        token: 'x',
        publicUrl: '',
      });
      expect(url).toBe('http://127.0.0.1:3456?token=x');
    });

    it('handles publicUrl with just origin (pathname=/ and no trailing slash)', () => {
      // When URL pathname is '/' and the origin part has no trailing path,
      // the function strips the pathname portion
      const url = buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 3456,
        token: 't',
        publicUrl: 'https://example.com',
      });
      expect(url).toBe('https://example.com?token=t');
    });
  });

  describe('envFlag', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
    });

    it('returns true for "1"', () => {
      process.env['TEST_FLAG'] = '1';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });

    it('returns true for "true"', () => {
      process.env['TEST_FLAG'] = 'true';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });

    it('returns true for "yes"', () => {
      process.env['TEST_FLAG'] = 'yes';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });

    it('returns true for "on"', () => {
      process.env['TEST_FLAG'] = 'on';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });

    it('returns false for "0"', () => {
      process.env['TEST_FLAG'] = '0';
      expect(envFlag('TEST_FLAG')).toBe(false);
    });

    it('returns false for "false"', () => {
      process.env['TEST_FLAG'] = 'false';
      expect(envFlag('TEST_FLAG')).toBe(false);
    });

    it('returns false for undefined env var', () => {
      delete process.env['TEST_FLAG'];
      expect(envFlag('TEST_FLAG')).toBe(false);
    });

    it('returns false for arbitrary string', () => {
      process.env['TEST_FLAG'] = 'maybe';
      expect(envFlag('TEST_FLAG')).toBe(false);
    });

    it('is case-insensitive after trim', () => {
      process.env['TEST_FLAG'] = '  TRUE  ';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });

    it('is case-insensitive for YES', () => {
      process.env['TEST_FLAG'] = 'YES';
      expect(envFlag('TEST_FLAG')).toBe(true);
    });
  });
});
