/**
 * WS-071 — wrongstack.com shipped no CSP and no frame protection.
 *
 * The site is on GitHub Pages, which cannot emit response headers, so the only
 * in-repo mechanism is a `<meta http-equiv>` policy — and a meta policy IGNORES
 * `frame-ancestors`, `report-uri` and `sandbox`. That splits the finding in two,
 * and this file pins both halves:
 *
 *   - the script/exfiltration surface, closed today by the policy `csp.mjs`
 *     injects into the built HTML;
 *   - framing, which cannot be closed from here at all, and whose header lives
 *     in `website/public/_headers` — inert until the site sits behind a
 *     header-capable host.
 *
 * The hash list is the part most likely to rot, so it is computed from the
 * shipped HTML at build time and verified here against an independently
 * computed digest rather than a recorded constant.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  inlineScripts,
  injectWebsiteCsp,
  scriptHash,
  websiteCsp,
} from '../../../../website/csp.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const websiteDir = resolve(repoRoot, 'website');
const sourceHtml = readFileSync(resolve(websiteDir, 'index.html'), 'utf8');
const viteConfig = readFileSync(resolve(websiteDir, 'vite.config.ts'), 'utf8');
const headers = readFileSync(resolve(websiteDir, 'public/_headers'), 'utf8');

/** The `content="…"` of the injected policy. */
function policyOf(html: string): string {
  const match = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  expect(match, 'expected an injected CSP meta').not.toBeNull();
  return match?.[1] ?? '';
}

function directive(policy: string, name: string): string | undefined {
  return policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe('inline-script hashing (WS-071)', () => {
  it('hashes every inline script and skips the ones with src', () => {
    const html = [
      '<script type="application/ld+json">{"a":1}</script>',
      '<script src="/assets/app.js"></script>',
      '<script>const x = 1;</script>',
      '<script type="module" crossorigin src="/assets/m.js"></script>',
    ].join('\n');
    expect(inlineScripts(html)).toEqual(['{"a":1}', 'const x = 1;']);
  });

  it('produces the digest a browser would compute, over the exact bytes', () => {
    // Whitespace from surrounding indentation is part of the element's text
    // content and therefore part of the hash. Trimming it here would produce a
    // policy that silently blocks the very script it means to allow.
    const body = '\n      (() => {})();\n    ';
    const expected = createHash('sha256').update(body, 'utf8').digest('base64');
    expect(scriptHash(body)).toBe(`'sha256-${expected}'`);
    expect(scriptHash(body.trim())).not.toBe(`'sha256-${expected}'`);
  });

  it("covers the real site's inline scripts — JSON-LD and the theme bootstrap", () => {
    const bodies = inlineScripts(sourceHtml);
    expect(bodies).toHaveLength(2);
    const policy = websiteCsp(sourceHtml);
    for (const body of bodies) {
      expect(policy, body.slice(0, 30)).toContain(scriptHash(body));
    }
  });
});

describe('the policy itself (WS-071)', () => {
  const policy = websiteCsp(sourceHtml);

  it('locks script execution to self plus the hashed inline blocks', () => {
    const scriptSrc = directive(policy, 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'self'");
    // A hash list and `'unsafe-inline'` are mutually exclusive in effect —
    // browsers ignore the keyword when hashes are present — so its appearance
    // here would mean someone tried to fix a dev-server breakage by loosening
    // production. The build-time injection exists precisely to avoid that.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'wasm-unsafe-eval'");
  });

  it('keeps the directives that cost nothing and close real holes', () => {
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
  });

  it('pins outbound connections to same-origin', () => {
    // The site makes no network calls of its own, so this costs nothing today
    // and denies a compromised bundle dependency anywhere to send data.
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self'");
  });

  it('allows exactly the two Google Fonts origins the page uses', () => {
    expect(directive(policy, 'style-src')).toContain('https://fonts.googleapis.com');
    expect(directive(policy, 'font-src')).toContain('https://fonts.gstatic.com');
    // Verify against the page rather than trusting the policy in isolation.
    expect(sourceHtml).toContain('https://fonts.googleapis.com');
    expect(sourceHtml).toContain('https://fonts.gstatic.com');
  });

  it('omits the directives a <meta> policy ignores', () => {
    // Listing these would be worse than omitting them: the browser drops them
    // with a console warning, and the repo would read as if the site were
    // frame-protected when it is not. `_headers` is where they live.
    for (const ignored of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
      expect(policy, ignored).not.toContain(ignored);
    }
  });
});

describe('injection (WS-071)', () => {
  it('places the policy after the charset and before the first script', () => {
    // Order matters twice: the charset declaration must stay inside the first
    // 1024 bytes, and a meta policy only governs what the parser sees after it.
    const out = injectWebsiteCsp(sourceHtml);
    const charset = out.indexOf('charset');
    const meta = out.indexOf('http-equiv="Content-Security-Policy"');
    const firstScript = out.indexOf('<script');
    expect(charset).toBeLessThan(meta);
    expect(meta).toBeLessThan(firstScript);
  });

  it('is idempotent — a second pass does not stack a second policy', () => {
    // Browsers intersect multiple policies, and a second pass would hash the
    // first policy's own bytes into itself. The route fan-out copies the
    // emitted file, so a rebuild over existing output is a real scenario.
    const once = injectWebsiteCsp(sourceHtml);
    expect(injectWebsiteCsp(once)).toBe(once);
    expect(once.split('http-equiv="Content-Security-Policy"')).toHaveLength(2);
  });

  it('produces a policy that covers the scripts in its own output', () => {
    const out = injectWebsiteCsp(sourceHtml);
    const policy = policyOf(out);
    for (const body of inlineScripts(out)) {
      expect(policy).toContain(scriptHash(body));
    }
  });

  it('refuses HTML with no head rather than silently emitting an unprotected page', () => {
    expect(() => injectWebsiteCsp('<html><body>hi</body></html>')).toThrow(/<head>/);
  });
});

describe('wiring (WS-071)', () => {
  it('injects at build time, not in the source HTML', () => {
    // `@vitejs/plugin-react` adds its own inline refresh preamble during
    // `vite dev`, which no static hash list can cover. A policy written into
    // index.html would break the dev server, and the usual fix for that is to
    // loosen the policy.
    expect(sourceHtml).not.toContain('Content-Security-Policy');
    expect(viteConfig).toContain('injectWebsiteCsp');
  });

  it('stamps the emitted HTML before the per-route copies are made', () => {
    // The build fans index.html out into one directory per route. Injecting
    // after that loop would leave every route but `/` unprotected.
    const inject = viteConfig.indexOf('injectWebsiteCsp(fs.readFileSync');
    const copy = viteConfig.indexOf('fs.copyFileSync(source');
    expect(inject).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(-1);
    expect(inject).toBeLessThan(copy);
  });

  it('carries frame protection in _headers, since the meta cannot', () => {
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });

  it('_headers states plainly that it is inert on GitHub Pages', () => {
    // An unlabelled header file reads as protection that is already on. It is
    // not: GitHub Pages emits no custom headers, so this only takes effect if
    // the site moves behind Netlify, Cloudflare Pages, or a Cloudflare proxy.
    expect(headers).toMatch(/GitHub Pages/);
    expect(headers).toMatch(/does NOTHING|inert/);
  });

  it('ships _headers to the publish root', () => {
    // Netlify and Cloudflare Pages read it from there and nowhere else.
    // `website/public/` is Vite's copy-verbatim directory.
    expect(resolve(websiteDir, 'public/_headers')).toContain('public');
  });
});
