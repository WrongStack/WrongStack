import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultWsUrl,
  getTokenFromPageUrl,
  getTokenFromWsUrl,
  httpOriginForAuth,
  resolvePublicWsUrl,
  stripTokenFromUrl,
} from '../../src/lib/ws-client-utils.js';

describe('ws-client-utils', () => {
  describe('getTokenFromWsUrl', () => {
    it('extracts token from a ws:// URL with ?token=', () => {
      expect(getTokenFromWsUrl('ws://127.0.0.1:3457?token=abc123')).toBe('abc123');
    });

    it('extracts token from a wss:// URL', () => {
      expect(getTokenFromWsUrl('wss://example.com:443/path?token=xyz789')).toBe('xyz789');
    });

    it('returns null when no token param is present', () => {
      expect(getTokenFromWsUrl('ws://127.0.0.1:3457')).toBeNull();
    });

    it('returns null for an invalid URL', () => {
      expect(getTokenFromWsUrl('not-a-url')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(getTokenFromWsUrl('')).toBeNull();
    });
  });

  describe('defaultWsUrl', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('returns loopback URL when on localhost', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'localhost', port: '3456', protocol: 'http:', search: '' },
        writable: true,
      });
      vi.spyOn(document, 'querySelector').mockReturnValue(null);
      expect(defaultWsUrl()).toBe('ws://127.0.0.1:3456');
    });

    it('returns loopback URL when on 127.0.0.1', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '127.0.0.1', port: '3456', protocol: 'http:', search: '' },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('ws://127.0.0.1:3456');
    });

    it('returns hostname-based URL for non-loopback hosts', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '192.168.1.100', port: '3456', protocol: 'http:', search: '' },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('ws://192.168.1.100:3456');
    });

    it('carries the page token into the initial WS URL', () => {
      Object.defineProperty(window, 'location', {
        value: {
          hostname: '192.168.1.100',
          port: '3456',
          protocol: 'http:',
          search: '?token=abc 123',
        },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('ws://192.168.1.100:3456?token=abc%20123');
    });

    it('uses wss when the page is served over https', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'wrongstack.example.com', port: '', protocol: 'https:', search: '' },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('wss://wrongstack.example.com');
    });

    it('prefers the injected public WebSocket URL', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'wrongstack.example.com', port: '', protocol: 'https:', search: '' },
        writable: true,
      });
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => 'wss://wrongstack-ws.example.com/socket',
      } as Element);
      expect(defaultWsUrl()).toBe('wss://wrongstack-ws.example.com/socket');
    });
  });

  describe('resolvePublicWsUrl', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
      vi.restoreAllMocks();
    });

    it('adds the page token when the public WS URL does not already have one', () => {
      Object.defineProperty(window, 'location', {
        value: { search: '?token=abc 123' },
        writable: true,
      });
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => 'wss://wrongstack-ws.example.com/socket',
      } as Element);
      expect(resolvePublicWsUrl()).toBe('wss://wrongstack-ws.example.com/socket?token=abc+123');
    });

    it('rejects non-WS public URLs', () => {
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => 'https://wrongstack.example.com',
      } as Element);
      expect(resolvePublicWsUrl()).toBeNull();
    });
  });

  describe('page-token helpers', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('reads token from the page URL', () => {
      Object.defineProperty(window, 'location', {
        value: { search: '?token=page-token' },
        writable: true,
      });
      expect(getTokenFromPageUrl()).toBe('page-token');
    });

    it('strips token from a WS URL', () => {
      expect(stripTokenFromUrl('ws://127.0.0.1:3457?token=secret&x=1')).toBe(
        'ws://127.0.0.1:3457/?x=1',
      );
    });
  });

  describe('httpOriginForAuth', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('returns loopback origin when on localhost', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'localhost', port: '3456', protocol: 'http:' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
    });

    it('returns loopback origin when on [::1]', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '[::1]', port: '3456', protocol: 'http:' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
    });

    it('uses page port for non-loopback hosts', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '192.168.1.50', port: '8080', protocol: 'http:' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://192.168.1.50:8080');
    });

    it('does not invent a port when page port is empty', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'example.com', port: '', protocol: 'https:' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('https://example.com');
    });
  });
});
