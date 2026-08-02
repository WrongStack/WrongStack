/**
 * WS-071 — the Content-Security-Policy for wrongstack.com, injected into the
 * built HTML.
 *
 * The site is served by GitHub Pages (`public/CNAME`), which cannot emit
 * response headers, so a `<meta http-equiv>` policy is the only mechanism
 * available in-repo. Two consequences shape everything below:
 *
 *  1. `frame-ancestors`, `report-uri` and `sandbox` are IGNORED when a policy
 *     is delivered by `<meta>`. They are deliberately absent — listing them
 *     would produce a console warning and, worse, read as protection that is
 *     not there. Frame protection therefore still requires a header-capable
 *     host; `public/_headers` carries it, inert until the site moves.
 *  2. A meta policy only governs what the parser sees AFTER it, so the tag goes
 *     as early as the document allows — right after `<meta charset>`, ahead of
 *     every script, style and fetched resource on the page.
 *
 * Injection happens at build time rather than being written into
 * `index.html`, for one practical reason: `@vitejs/plugin-react` injects its
 * refresh preamble as an inline script during `vite dev`, which no static hash
 * list can cover. A hand-written policy in the source HTML would break the dev
 * server, and the standard fix for that is to loosen the policy — which is how
 * a `script-src` ends up with `'unsafe-inline'` in it.
 *
 * Hashes are computed from the shipped HTML, so they cannot drift out of sync
 * with the script they authorise.
 */
import { createHash } from 'node:crypto';

/** Inline `<script>` bodies in document order — those without a `src`. */
export function inlineScripts(html) {
  const out = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    const attrs = match[1] ?? '';
    if (!/\ssrc\s*=/i.test(attrs)) out.push(match[2] ?? '');
    match = pattern.exec(html);
  }
  return out;
}

/**
 * CSP source expression for one inline script. The digest is over the exact
 * bytes of the element's text content — including the leading and trailing
 * whitespace that the surrounding indentation contributes — so the body must
 * be passed through untouched.
 */
export function scriptHash(body) {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

export function websiteCsp(html) {
  const hashes = inlineScripts(html).map(scriptHash);
  return [
    "default-src 'self'",
    // The whole point of the policy. `'self'` covers the Vite bundle and its
    // lazily-imported route chunks; the hashes cover the two inline blocks
    // (theme bootstrap, JSON-LD). No `'unsafe-inline'` and no `'unsafe-eval'`:
    // the built bundle contains neither `eval(` nor `new Function`, verified
    // against `dist/assets/*.js`.
    ["script-src 'self'", ...hashes].join(' '),
    // `'unsafe-inline'` is unavoidable here and is not a meaningful weakening:
    // the app sets element `style` props directly and framer-motion animates
    // through inline styles. Style injection cannot execute script under the
    // `script-src` above.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Deliberately broad. Provider and plan logos are hotlinked from nine
    // vendor CDNs enumerated in `src/data/providers.ts` and
    // `src/data/coding-plans.ts`; pinning them would mean every new provider
    // row silently breaks its own logo in production only. Images cannot
    // execute, and the exfiltration channel a broad `img-src` would open
    // requires injected script, which `script-src` denies.
    "img-src 'self' data: https:",
    // The site makes no network calls of its own — no fetch, XHR, WebSocket,
    // EventSource or sendBeacon anywhere in `src/`. Keeping this at `'self'`
    // means a compromised bundle dependency has nowhere to send anything.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const META_MARKER = 'http-equiv="Content-Security-Policy"';

/**
 * Insert the policy as early as possible: directly after `<meta charset>` when
 * present, otherwise after `<head>`. Going after the charset keeps that
 * declaration first — it must land inside the document's first 1024 bytes, and
 * pushing half a kilobyte of policy ahead of it eats that budget for no gain.
 * The policy only has to precede the first script, style or fetched resource,
 * and a charset declaration is none of those.
 *
 * Returns the HTML unchanged if a policy is already present, so re-running a
 * build over an emitted file cannot stack two conflicting policies (browsers
 * intersect them, and the second would be built from the first's own bytes).
 */
export function injectWebsiteCsp(html) {
  if (html.includes(META_MARKER)) return html;
  const charset = /<meta[^>]*\scharset\s*=[^>]*>/i.exec(html);
  const anchor = charset ?? /<head[^>]*>/i.exec(html);
  if (anchor === null) throw new Error('website CSP: no <head> in the built HTML');
  const at = anchor.index + anchor[0].length;
  const meta = `\n    <meta ${META_MARKER} content="${websiteCsp(html)}" />`;
  return html.slice(0, at) + meta + html.slice(at);
}
