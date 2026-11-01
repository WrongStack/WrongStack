/**
 * Move every inline `<script>` of the static export into its own file.
 *
 * HQ serves its dashboard under `script-src 'self'` with no exceptions — no
 * `'unsafe-inline'`, no hashes, no nonces. Next's export embeds the route's
 * React Server Component payload as inline `self.__next_f.push(...)` scripts,
 * which that policy (correctly) refuses to run. Rewriting each run of adjacent
 * inline scripts into one content-addressed external script keeps document
 * order — classic external scripts without `async`/`defer` execute exactly
 * where the inline ones did — while the policy stays untouched.
 *
 * Fails closed: an inline script carrying any attribute (a `type`, `nonce`,
 * `id`, …) is something this transform does not understand, so the build stops
 * instead of shipping a page the CSP would silently break.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INLINE_SCRIPT_DIR = '_next/static/inline';

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HAS_SRC = /\bsrc\s*=/i;

/**
 * @param {string} html
 * @returns {{ html: string; files: Map<string, string> }}
 */
export function externalizeInlineScripts(html) {
  /** @type {Map<string, string>} */
  const files = new Map();
  let out = '';
  let last = 0;
  /** @type {string[] | null} */
  let run = null;

  const flush = () => {
    if (run === null) return;
    const bodies = run.filter((body) => body.trim() !== '');
    run = null;
    if (bodies.length === 0) return;
    const content = `${bodies.join(';\n')};\n`;
    const name = `${createHash('sha256').update(content).digest('hex').slice(0, 24)}.js`;
    files.set(name, content);
    out += `<script src="/${INLINE_SCRIPT_DIR}/${name}"></script>`;
  };

  for (const match of html.matchAll(SCRIPT)) {
    const [whole, attributes = '', body = ''] = match;
    const start = match.index;
    const gap = html.slice(last, start);
    last = start + whole.length;

    if (HAS_SRC.test(attributes)) {
      flush();
      out += gap + whole;
      continue;
    }
    if (attributes.trim() !== '') {
      throw new Error(
        `Unsupported inline <script${attributes}>: HQ forbids inline scripts and this build ` +
          'step only knows how to move attribute-less ones. Extend it deliberately.',
      );
    }
    if (run !== null && gap.trim() === '') {
      run.push(body);
      continue;
    }
    flush();
    out += gap;
    run = [body];
  }
  flush();
  out += html.slice(last);
  return { html: out, files };
}

/** Every inline script still present in `html` (should be none after the transform). */
export function remainingInlineScripts(html) {
  return [...html.matchAll(SCRIPT)].filter(([, attributes = '']) => !HAS_SRC.test(attributes));
}

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

/**
 * Rewrite every HTML file under `outputDir` in place and write the extracted
 * scripts under `<outputDir>/_next/static/inline/`.
 *
 * @returns {{ pages: number; scripts: number }}
 */
export function externalizeDirectory(outputDir) {
  const scriptDir = join(outputDir, INLINE_SCRIPT_DIR);
  mkdirSync(scriptDir, { recursive: true });
  const written = new Set();
  let pages = 0;
  for (const file of htmlFiles(outputDir)) {
    const { html, files } = externalizeInlineScripts(readFileSync(file, 'utf8'));
    for (const [name, content] of files) {
      if (!written.has(name)) writeFileSync(join(scriptDir, name), content);
      written.add(name);
    }
    if (remainingInlineScripts(html).length > 0) {
      throw new Error(`Inline script survived externalization in ${file}`);
    }
    writeFileSync(file, html);
    pages += 1;
  }
  return { pages, scripts: written.size };
}
