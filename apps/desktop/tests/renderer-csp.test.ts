/**
 * WS-061 — the Electron renderer's CSP.
 *
 * This is the fourth served surface and the one most easily missed: webui and
 * simpleui share `buildCspHeader` in @wrongstack/webui-server and HQ builds its
 * header in code, but the renderer declares its policy in a `<meta>` tag in
 * static HTML. Nothing imports it, so no existing test touched it, and it
 * carried `script-src 'unsafe-inline'` unnoticed alongside the others.
 *
 * A renderer is the worst place to keep that keyword: it runs with whatever
 * bridge the preload script exposes, so inline-script execution there is closer
 * to the host than it is in a browser tab.
 *
 * Asserted against the source HTML because that is what ships — the Vite build
 * copies the `<meta>` through verbatim.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererHtml = readFileSync(
  resolve(import.meta.dirname, '../src/renderer/index.html'),
  'utf8',
);

function cspContent(): string {
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(rendererHtml);
  expect(match, 'renderer index.html must declare a CSP meta tag').not.toBeNull();
  return match![1]!;
}

function directive(name: string): string | undefined {
  return cspContent()
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name} `) || s === name);
}

describe('Electron renderer CSP (WS-061)', () => {
  it('does not allow inline script', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('ships no inline script for the policy to need', () => {
    // The premise of the assertion above, checked rather than assumed: every
    // <script> in the document loads from a URL.
    const tags = rendererHtml.match(/<script[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((t) => !t.includes('src='))).toEqual([]);
  });

  it('does not reintroduce per-extension hashes', () => {
    expect(cspContent()).not.toMatch(/'sha256-/);
  });

  it('keeps inline STYLE, which is not script execution', () => {
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('keeps the renderer locked to same-origin fetches', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });
});
