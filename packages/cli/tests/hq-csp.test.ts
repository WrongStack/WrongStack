/**
 * WS-061 — HQ security headers, and specifically `script-src`.
 *
 * The HQ server had NO test covering its CSP at all, which is how
 * `'unsafe-inline'` ended up in its `script-src` while the function's own
 * doc comment said "The missing-assets recovery document contains inline CSS
 * but no script". The comment was right and the header disagreed with it; with
 * nothing asserting the header, there was nothing to notice.
 *
 * The sibling surfaces (webui, simpleui) share `buildCspHeader` in
 * @wrongstack/webui-server and are pinned by two tests there. HQ builds its
 * header independently, so it needs its own.
 */
import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { setHqSecurityHeaders } from '../src/hq-server/auth.js';

/** Minimal ServerResponse stand-in — the function only calls setHeader. */
function captureHeaders(): { headers: Map<string, string>; res: http.ServerResponse } {
  const headers = new Map<string, string>();
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as http.ServerResponse;
  return { headers, res };
}

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name} `) || s === name);
}

function hqCsp(): string {
  const { headers, res } = captureHeaders();
  setHqSecurityHeaders(res);
  const csp = headers.get('content-security-policy');
  expect(csp).toBeDefined();
  return csp!;
}

describe('HQ script-src (WS-061)', () => {
  it('does not allow inline script', () => {
    // Verified against the built artifact rather than assumed:
    // packages/webui-hq/dist/index.html has zero inline <script> without src.
    expect(directive(hqCsp(), 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('does not creep back via per-extension hashes either', () => {
    // The narrow workaround this project rejected on 2026-07-15. Removing
    // `'unsafe-inline'` must not reopen the door to the thing it replaced.
    expect(hqCsp()).not.toMatch(/'sha256-/);
  });

  it('keeps wasm-unsafe-eval — Shiki compiles its grammar engine to WebAssembly', () => {
    // Without it every code block in the UI throws
    //   CompileError: call to WebAssembly.instantiate() blocked by CSP
    expect(directive(hqCsp(), 'script-src')).toMatch(/'wasm-unsafe-eval'/);
  });
});

describe('HQ CSP surrounding directives (WS-061)', () => {
  it('still allows inline STYLE — the recovery document has real inline CSS', () => {
    // Inline style is not script execution; this is the one keyword the
    // function's doc comment actually justifies.
    expect(directive(hqCsp(), 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('keeps the framing, object, and base restrictions', () => {
    const csp = hqCsp();
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('sets the non-CSP hardening headers alongside it', () => {
    const { headers, res } = captureHeaders();
    setHqSecurityHeaders(res);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });
});
