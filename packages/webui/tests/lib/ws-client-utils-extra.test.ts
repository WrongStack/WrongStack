/**
 * Additional tests for src/lib/ws-client-utils.ts — safePayload, pipeViz,
 * isActiveSessionMessage, stripTokenFromAddressBar, and other edge cases.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isActiveSessionMessage,
  safePayload,
  stripTokenFromAddressBar,
  stripTokenFromUrl,
  getTokenFromPageUrl,
  defaultWsUrl,
  httpOriginForAuth,
  resolvePublicWsUrl,
} from '../../src/lib/ws-client-utils';
import type { WSServerMessage } from '../../src/types';

describe('isActiveSessionMessage', () => {
  it('returns true when message has no sessionId', () => {
    const msg = { type: 'chat.message', payload: {} } as unknown as WSServerMessage;
    expect(isActiveSessionMessage(msg)).toBe(true);
  });

  it('returns true when no active session is set', () => {
    const msg = {
      type: 'chat.message',
      payload: { sessionId: 'sess-1' },
    } as unknown as WSServerMessage;
    expect(isActiveSessionMessage(msg)).toBe(true);
  });

  it('returns true when sessionId matches the active session', async () => {
    const { useSessionStore } = await import('../../src/stores/session-store');
    useSessionStore.setState({
      session: { id: 'sess-1', startedAt: Date.now(), provider: 'test', model: 'test-model' },
    });

    const msg = {
      type: 'chat.message',
      payload: { sessionId: 'sess-1' },
    } as unknown as WSServerMessage;
    expect(isActiveSessionMessage(msg)).toBe(true);
  });

  it('returns false when sessionId does not match', async () => {
    const { useSessionStore } = await import('../../src/stores/session-store');
    useSessionStore.setState({
      session: { id: 'sess-active', startedAt: Date.now(), provider: 'test', model: 'test-model' },
    });

    const msg = {
      type: 'chat.message',
      payload: { sessionId: 'sess-other' },
    } as unknown as WSServerMessage;
    expect(isActiveSessionMessage(msg)).toBe(false);
  });

  // Fail-closed on present-but-empty sessionId: the server stamps
  // `sessionId: ''` when its context has no session (sessionPayload), and
  // that stamp must not silently widen into "every session" — the receiving
  // end of the cross-session todo bleed.
  it('returns false when sessionId is present but empty', async () => {
    const { useSessionStore } = await import('../../src/stores/session-store');
    useSessionStore.setState({
      session: { id: 'sess-active', startedAt: Date.now(), provider: 'test', model: 'test-model' },
    });

    const msg = {
      type: 'kanban.todos.updated',
      payload: { sessionId: '' },
    } as unknown as WSServerMessage;
    expect(isActiveSessionMessage(msg)).toBe(false);
  });
});

describe('safePayload', () => {
  it('returns typed payload when all required keys match', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello', count: 42 },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string; count: number }>(msg, {
      text: 'string',
      count: 'number',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello');
    expect(result!.count).toBe(42);
  });

  it('returns null when a required key is missing', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello' },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string; count: number }>(msg, {
      text: 'string',
      count: 'number',
    });
    expect(result).toBeNull();
  });

  it('returns null when a required key has wrong type', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello', count: 'not-a-number' },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string; count: number }>(msg, {
      text: 'string',
      count: 'number',
    });
    expect(result).toBeNull();
  });

  it('returns null when payload is missing', () => {
    const msg = { type: 'custom.event' } as unknown as WSServerMessage;
    const result = safePayload<{ text: string }>(msg, { text: 'string' });
    expect(result).toBeNull();
  });

  it('validates optional keys only when present and correct', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello', extra: 'optional-value' },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string; extra?: string }>(
      msg,
      { text: 'string' },
      { extra: 'string' },
    );
    expect(result).not.toBeNull();
    expect(result!.extra).toBe('optional-value');
  });

  it('rejects when optional key has wrong type', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello', extra: 42 },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string; extra?: string }>(
      msg,
      { text: 'string' },
      { extra: 'string' },
    );
    expect(result).toBeNull();
  });

  it('accepts when optional key is absent', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello' },
    } as unknown as WSServerMessage;
    const result = safePayload<{ text: string }>(msg, { text: 'string' }, { extra: 'string' });
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello');
  });

  it('handles various kind checks', () => {
    const msg = {
      type: 'custom.event',
      payload: {
        flag: true,
        meta: { key: 'val' },
        items: [1, 2, 3],
      },
    } as unknown as WSServerMessage;
    const result = safePayload(msg, { flag: 'boolean', meta: 'object', items: 'array' });
    expect(result).not.toBeNull();
  });

  it('returns null for unknown kind type', () => {
    const msg = {
      type: 'custom.event',
      payload: { text: 'hello' },
    } as unknown as WSServerMessage;
    const result = safePayload(msg, { text: 'unknown_kind' as any });
    expect(result).toBeNull();
  });
});

describe('stripTokenFromAddressBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(() => stripTokenFromAddressBar()).not.toThrow();
  });

  it('is a no-op when window.location is undefined', () => {
    vi.stubGlobal('window', {});
    expect(() => stripTokenFromAddressBar()).not.toThrow();
  });

  it('is a no-op when history.replaceState is unavailable', () => {
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:3456?token=abc' },
      history: {},
    });
    expect(() => stripTokenFromAddressBar()).not.toThrow();
  });

  it('removes token from the address bar URL', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:3456?token=abc&foo=bar' },
      history: { state: {}, replaceState },
    });
    stripTokenFromAddressBar();
    expect(replaceState).toHaveBeenCalledWith(
      {},
      expect.any(String),
      'http://localhost:3456/?foo=bar',
    );
  });

  it('does nothing when no token is in the URL', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:3456' },
      history: { state: {}, replaceState },
    });
    stripTokenFromAddressBar();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('getTokenFromPageUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(getTokenFromPageUrl()).toBeNull();
  });

  it('returns null when window.location is null', () => {
    vi.stubGlobal('window', {});
    expect(getTokenFromPageUrl()).toBeNull();
  });

  it('returns null when search is empty', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(getTokenFromPageUrl()).toBeNull();
  });
});

describe('stripTokenFromUrl', () => {
  it('returns the raw URL when it is invalid', () => {
    expect(stripTokenFromUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('defaultWsUrl edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles IPv6 loopback [::1]', () => {
    vi.stubGlobal('window', {
      location: { hostname: '[::1]', port: '3456', protocol: 'http:', search: '' },
    });
    expect(defaultWsUrl()).toBe('ws://127.0.0.1:3456');
  });

  it('handles ::1 (without brackets)', () => {
    vi.stubGlobal('window', {
      location: { hostname: '::1', port: '3456', protocol: 'http:', search: '' },
    });
    expect(defaultWsUrl()).toBe('ws://127.0.0.1:3456');
  });
});

describe('resolvePublicWsUrl edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when meta tag content is whitespace after trim', () => {
    vi.spyOn(document, 'querySelector').mockReturnValue({
      getAttribute: () => '   ',
    } as Element);
    expect(resolvePublicWsUrl()).toBeNull();
  });

  it('returns null when the wsUrl is not a valid URL', () => {
    vi.spyOn(document, 'querySelector').mockReturnValue({
      getAttribute: () => 'not a valid url',
    } as Element);
    expect(resolvePublicWsUrl()).toBeNull();
  });

  it('returns null when document is undefined', () => {
    vi.stubGlobal('document', undefined);
    expect(resolvePublicWsUrl()).toBeNull();
  });
});

describe('httpOriginForAuth edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles missing window/ location', () => {
    vi.stubGlobal('window', undefined);
    expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
  });

  it('handles ::1 hostname', () => {
    vi.stubGlobal('window', {
      location: { hostname: '::1', port: '3456', protocol: 'http:' },
    });
    expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
  });
});
