/**
 * HQ serves its dashboard under `script-src 'self'` with no exceptions, so the
 * Next export's inline payload scripts must leave the HTML at build time. These
 * tests pin the three properties that make that safe: nothing inline survives,
 * execution order is unchanged, and anything unrecognised stops the build.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  externalizeDirectory,
  externalizeInlineScripts,
  INLINE_SCRIPT_DIR,
  remainingInlineScripts,
} from '../scripts/externalize-inline-scripts.mjs';

const PUSH_0 = '(self.__next_f=self.__next_f||[]).push([0])';
const PUSH_1 = 'self.__next_f.push([1,"a"])';
const PUSH_2 = 'self.__next_f.push([1,"b"])';

describe('externalizeInlineScripts', () => {
  it('replaces a run of adjacent inline scripts with one external script, in order', () => {
    const html = `<body><div id="root"></div><script src="/_next/static/chunks/main.js" async=""></script><script>${PUSH_0}</script>\n<script>${PUSH_1}</script></body>`;
    const { html: out, files } = externalizeInlineScripts(html);

    expect(remainingInlineScripts(out)).toHaveLength(0);
    expect(files.size).toBe(1);
    const [entry] = [...files];
    if (entry === undefined) throw new Error('expected one externalized script');
    const [name, content] = entry;
    expect(content).toBe(`${PUSH_0};\n${PUSH_1};\n`);
    expect(out).toBe(
      `<body><div id="root"></div><script src="/_next/static/chunks/main.js" async=""></script><script src="/${INLINE_SCRIPT_DIR}/${name}"></script></body>`,
    );
  });

  it('keeps separate runs where markup sits between them, so each still runs after its markup', () => {
    const html = `<script>${PUSH_1}</script><template id="P:1"></template><script>${PUSH_2}</script>`;
    const { html: out, files } = externalizeInlineScripts(html);

    expect(files.size).toBe(2);
    expect([...files.values()]).toEqual([`${PUSH_1};\n`, `${PUSH_2};\n`]);
    expect(out).toMatch(
      /^<script src="[^"]+"><\/script><template id="P:1"><\/template><script src="[^"]+"><\/script>$/,
    );
  });

  it('names files by content, so identical payloads share one file', () => {
    const first = externalizeInlineScripts(`<script>${PUSH_1}</script>`).files;
    const second = externalizeInlineScripts(`<p>other page</p><script>${PUSH_1}</script>`).files;
    expect([...first.keys()]).toEqual([...second.keys()]);
    expect([...first.keys()][0]).toMatch(/^[0-9a-f]{24}\.js$/);
  });

  it('drops empty inline scripts instead of emitting empty files', () => {
    const { html: out, files } = externalizeInlineScripts('<p>x</p><script>  </script>');
    expect(files.size).toBe(0);
    expect(out).toBe('<p>x</p>');
  });

  it('refuses an inline script it does not understand rather than shipping it', () => {
    for (const attrs of [' type="application/ld+json"', ' nonce="abc"', ' id="x"']) {
      expect(() => externalizeInlineScripts(`<script${attrs}>${PUSH_1}</script>`)).toThrow(
        /Unsupported inline <script/,
      );
    }
  });
});

describe('externalizeDirectory', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('rewrites every exported page and leaves no inline script anywhere', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-next-externalize-'));
    mkdirSync(join(dir, 'fleet', 'console'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<script>${PUSH_0}</script><script>${PUSH_1}</script>`);
    writeFileSync(join(dir, 'fleet', 'console', 'index.html'), `<script>${PUSH_2}</script>`);
    writeFileSync(join(dir, '404.html'), `<script>${PUSH_0}</script><script>${PUSH_1}</script>`);

    expect(externalizeDirectory(dir)).toEqual({ pages: 3, scripts: 2 });
    for (const page of ['index.html', 'fleet/console/index.html', '404.html']) {
      expect(remainingInlineScripts(readFileSync(join(dir, page), 'utf8'))).toHaveLength(0);
    }
    expect(readdirSync(join(dir, INLINE_SCRIPT_DIR))).toHaveLength(2);
  });
});
