import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { hasTrustedBrowserOrigin } from '../src/hq-server/auth.js';

function request(origin: string | undefined, host: string | undefined): http.IncomingMessage {
  return {
    headers: { ...(origin ? { origin } : {}), ...(host ? { host } : {}) },
  } as http.IncomingMessage;
}

describe('HQ browser origin validation', () => {
  it('accepts an exact HTTPS origin registered by a trusted tunnel', () => {
    expect(
      hasTrustedBrowserOrigin(
        request('https://quiet-river.trycloudflare.com', 'quiet-river.trycloudflare.com'),
        '127.0.0.1',
        3499,
        new Set(['https://quiet-river.trycloudflare.com']),
      ),
    ).toBe(true);
  });

  it('rejects matching attacker-controlled Host and Origin headers after DNS rebinding', () => {
    expect(
      hasTrustedBrowserOrigin(
        request('https://attacker.example', 'attacker.example'),
        '127.0.0.1',
        3499,
      ),
    ).toBe(false);
  });

  it('rejects a rebound attacker Host even when a same-origin GET omits Origin', () => {
    expect(
      hasTrustedBrowserOrigin(request(undefined, 'attacker.example:3499'), '127.0.0.1', 3499),
    ).toBe(false);
  });

  it('does not let an HTTP origin reuse an HTTPS tunnel authority', () => {
    expect(
      hasTrustedBrowserOrigin(
        request('http://quiet-river.trycloudflare.com', 'quiet-river.trycloudflare.com'),
        '127.0.0.1',
        3499,
        new Set(['https://quiet-river.trycloudflare.com']),
      ),
    ).toBe(false);
  });

  it('normalizes an explicit default HTTPS port on a registered tunnel', () => {
    expect(
      hasTrustedBrowserOrigin(
        request('https://quiet-river.trycloudflare.com', 'quiet-river.trycloudflare.com:443'),
        '127.0.0.1',
        3499,
        new Set(['https://quiet-river.trycloudflare.com']),
      ),
    ).toBe(true);
  });

  it('accepts same-host LAN browser traffic', () => {
    expect(
      hasTrustedBrowserOrigin(
        request('http://192.168.1.20:3499', '192.168.1.20:3499'),
        '0.0.0.0',
        3499,
      ),
    ).toBe(true);
  });

  it('rejects a different browser origin even when it claims forwarded headers', () => {
    const req = request('https://evil.example', 'quiet-river.trycloudflare.com');
    req.headers['x-forwarded-host'] = 'evil.example';
    expect(hasTrustedBrowserOrigin(req, '127.0.0.1', 3499)).toBe(false);
  });

  it('keeps accepting non-browser clients without Origin', () => {
    expect(hasTrustedBrowserOrigin(request(undefined, '127.0.0.1:3499'), '127.0.0.1', 3499)).toBe(
      true,
    );
  });

  // WS-081. `file:` was trusted unconditionally, and the Host check above does
  // not contain it: a page opened from disk can aim at the real HQ authority,
  // and Chromium sends a literal `Origin: file://` on WebSocket handshakes too.
  // So any locally-opened HTML file cleared HQ's only cross-origin control on
  // both surfaces — and /ws/browser needs no token in open mode.
  describe('file:// origins', () => {
    const fileReq = () => request('file://', '127.0.0.1:3499');

    it('rejects a file:// origin by default', () => {
      expect(hasTrustedBrowserOrigin(fileReq(), '127.0.0.1', 3499)).toBe(false);
    });

    it('rejects it even though the Host header names the real HQ endpoint', () => {
      // The point of the finding: the Host check cannot distinguish a local
      // file's request from the dashboard's own.
      expect(hasTrustedBrowserOrigin(fileReq(), '127.0.0.1', 3499, new Set())).toBe(false);
    });

    it('accepts it when air-gapped file serving is explicitly enabled', () => {
      expect(hasTrustedBrowserOrigin(fileReq(), '127.0.0.1', 3499, new Set(), true)).toBe(true);
    });

    it('still enforces the Host check when file origins are enabled', () => {
      expect(
        hasTrustedBrowserOrigin(request('file://', 'attacker.example'), '127.0.0.1', 3499, new Set(), true),
      ).toBe(false);
    });
  });
});
