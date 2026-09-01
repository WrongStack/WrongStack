import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Integrity gate for the committed tree-sitter WASM binaries.
 *
 * The 2026-08-20 security-check audit found 14 `.wasm` files committed under
 * `codebase-index/wasm/` with **no recorded provenance**. They are loaded and
 * executed on every indexing run, and the index feeds `@wrongstack/security-scanner`.
 * Thirteen of them were traced to `tree-sitter-wasm@1.1.4` — a package created
 * 2026-05-25 with a single individual maintainer and ~5.6k weekly downloads
 * (versus 5.2M for the official `web-tree-sitter` sitting beside it in the same
 * manifest), whose build script is not published, so the binaries cannot be
 * reproduced from the published artifact.
 *
 * Nothing here can establish upstream provenance after the fact. What it CAN do
 * is make a later change to these bytes impossible to land silently: swapping a
 * grammar now fails CI instead of shipping. Regenerate `checksums.json`
 * deliberately, in a reviewed commit, whenever a grammar is genuinely updated
 * (`node scripts/check-tree-sitter-wasm.mjs --write`).
 *
 * Single source of truth (2026-09-01 consistency pass): this test reads the
 * SAME `checksums.json` that the CI build job (scripts/check-tree-sitter-
 * wasm.mjs) and the runtime integrity gate (tree-sitter-parser.ts) consume.
 * A separate SHA256SUMS.json duplicate was consolidated away — two manifests
 * for the same 14 binaries could drift and disagree about what "intact"
 * means. Its byte-size field is subsumed by sha256.
 */

const WASM_DIR = fileURLToPath(new URL('../src/codebase-index/wasm/', import.meta.url));
const MANIFEST = path.join(WASM_DIR, 'checksums.json');

function listWasmFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listWasmFiles(p, base));
    } else if (e.name.endsWith('.wasm')) {
      out.push(path.relative(base, p).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;
const onDisk = listWasmFiles(WASM_DIR);

describe('committed WASM binaries match their recorded checksums', () => {
  it('the manifest covers exactly the files on disk', () => {
    // Both directions matter: an unlisted new binary is the interesting case,
    // and a stale entry means a grammar was removed without updating the gate.
    expect(Object.keys(manifest).sort()).toEqual(onDisk);
  });

  it.each(onDisk)('%s is unmodified', (rel) => {
    const expected = manifest[rel];
    expect(expected, `${rel} has no manifest entry`).toBeDefined();
    const buf = readFileSync(path.join(WASM_DIR, rel));
    expect(createHash('sha256').update(buf).digest('hex'), `${rel} contents changed`).toBe(
      expected,
    );
  });
});
