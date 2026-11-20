import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { anchorVerificationCoverage } from '../src/anchors/verify.js';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { SymbolSpanReader } from '../src/types.js';

/**
 * #418: a symbol anchor recorded no baseline, so rewriting the symbol's body and keeping its
 * name still verified, and the outdated memory kept being injected. A memory now records a
 * hash of the symbol's own span when it is written and goes stale when that span changes.
 * Real store, real tempdir, production `rememberSage`/`verifyForPaths`; only the span source
 * (the codebase index in production) is a small stand-in here.
 */

/** Finds `function <name>(...) { ... }` by brace matching. Ambiguous or missing: null. */
const braceReader: SymbolSpanReader = async (absPath, symbol) => {
  const text = await fs.readFile(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (line.includes(`function ${symbol}(`) ? [i] : []));
  if (starts.length !== 1) return null;
  const start = starts[0]!;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth === 0 && lines[i]!.includes('}')) {
      return { startLine: start + 1, endLine: i + 1, text: lines.slice(start, i + 1).join('\n') };
    }
  }
  return null;
};

const temps: Array<{ dir: string; store: SqliteSageStore }> = [];

async function project(
  source: string,
  reader: SymbolSpanReader | null = braceReader,
): Promise<{ dir: string; store: SqliteSageStore; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-span-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  const file = path.join(dir, 'src', 'tax.ts');
  await fs.writeFile(file, source);
  const store = new SqliteSageStore({
    projectRoot: dir,
    ...(reader ? { symbolSpans: reader } : {}),
  });
  await store.initialize();
  temps.push({ dir, store });
  return { dir, store, file };
}

afterEach(async () => {
  for (const entry of temps.splice(0)) {
    entry.store.close();
    await removeProjectFixtureDirectory(entry.dir, { maxRetries: 5, retryDelay: 50 });
  }
});

const ORIGINAL = [
  'export const RATE = 0.2;',
  '',
  'export function calculateTax(amount: number): number {',
  '  return Math.ceil(amount * RATE);',
  '}',
  '',
].join('\n');

const REWRITTEN = ORIGINAL.replace('Math.ceil(amount * RATE)', 'Math.round(amount * RATE)');

async function rememberTax(store: SqliteSageStore) {
  return store.rememberSage({
    text: 'calculateTax rounds up because regulation X requires it',
    kind: 'decision',
    anchors: [{ type: 'symbol', path: 'src/tax.ts', symbol: 'calculateTax' }],
  });
}

describe('a symbol anchor checks the symbol body it was written against (#418)', () => {
  it('goes stale when the body changes and the name stays', async () => {
    const { store, file } = await project(ORIGINAL);
    const memory = await rememberTax(store);

    await fs.writeFile(file, REWRITTEN);
    const [result] = await store.verifyForPaths([file]);

    expect(result?.status).toBe('stale');
    expect((await store.getSage(memory.id))?.status).toBe('stale');
  });

  it('stays verified when the symbol only moves, or only its formatting changes', async () => {
    const { store, file } = await project(ORIGINAL);
    const memory = await rememberTax(store);
    const [anchor] = memory.anchors;
    expect(anchor?.contentHash).toMatch(/^span:v1:sha256:[0-9a-f]{64}$/);
    expect([anchor?.lineStart, anchor?.lineEnd]).toEqual([3, 5]);

    // Code added above the symbol, CRLF line endings and trailing spaces inside it.
    const moved = `import { log } from './log';\n\n${ORIGINAL}`
      .replace('{\n  return', '{   \n  return')
      .replaceAll('\n', '\r\n');
    await fs.writeFile(file, moved);

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');
    expect((await store.getSage(memory.id))?.status).toBe('active');
  });

  it('verifies again once the body is back to the one it was written against', async () => {
    const { store, file } = await project(ORIGINAL);
    const memory = await rememberTax(store);
    await fs.writeFile(file, REWRITTEN);
    await store.verifyForPaths([file]);
    expect((await store.getSage(memory.id))?.status).toBe('stale');

    await fs.writeFile(file, ORIGINAL);
    await store.verifyForPaths([file]);

    expect((await store.getSage(memory.id))?.status).toBe('active');
  });

  it('re-remembering a stale memory takes the current body as its baseline, as one anchor', async () => {
    const { store, file } = await project(ORIGINAL);
    const memory = await rememberTax(store);
    await fs.writeFile(file, REWRITTEN);
    await store.verifyForPaths([file]);

    const reasserted = await rememberTax(store);
    expect(reasserted.id).toBe(memory.id);
    expect(reasserted.status).toBe('active');
    expect(reasserted.anchors).toHaveLength(1);
    expect(reasserted.anchors[0]?.contentHash).not.toBe(memory.anchors[0]?.contentHash);

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');
    expect((await store.getSage(memory.id))?.status).toBe('active');
  });

  it('confirming a stale memory as active through an update re-baselines it', async () => {
    const { store, file } = await project(ORIGINAL);
    const memory = await rememberTax(store);
    await fs.writeFile(file, REWRITTEN);
    await store.verifyForPaths([file]);

    const confirmed = await store.updateSage(memory.id, { status: 'active' });
    expect(confirmed.anchors[0]?.contentHash).not.toBe(memory.anchors[0]?.contentHash);

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');
    expect((await store.getSage(memory.id))?.status).toBe('active');
  });

  it('control: without a span source a symbol anchor is still checked by name only', async () => {
    const { store, file } = await project(ORIGINAL, null);
    const memory = await rememberTax(store);
    expect(memory.anchors[0]?.contentHash).toBeUndefined();

    await fs.writeFile(file, REWRITTEN);
    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');

    await fs.writeFile(file, ORIGINAL.replaceAll('calculateTax', 'computeTax'));
    expect((await store.verifyForPaths([file]))[0]?.status).toBe('stale');
  });

  it('a span it cannot read, or a baseline from another version, falls back to the name check', async () => {
    const { dir, file } = await project(ORIGINAL);
    await fs.writeFile(file, REWRITTEN);
    const base = { type: 'symbol', path: 'src/tax.ts', symbol: 'calculateTax' } as const;
    const verify = (anchor: object, reader: SymbolSpanReader) =>
      anchorVerificationCoverage.verifyAnchor(dir, anchor as never, undefined, undefined, reader);
    // A current-version baseline of some other body.
    const stored = { ...base, contentHash: 'span:v1:sha256:'.padEnd(79, '0') };

    // Ambiguous, unsupported or failing reader: name check.
    expect((await verify(stored, async () => null)).status).toBe('verified');
    expect(
      (
        await verify(stored, async () => {
          throw new Error('parser crashed');
        })
      ).status,
    ).toBe('verified');
    // A baseline cut by another version of the span rules is not compared.
    expect((await verify({ ...base, contentHash: 'span:v2:sha256:abc' }, braceReader)).status).toBe(
      'verified',
    );
    // The same stored baseline with a readable span is compared.
    expect((await verify(stored, braceReader)).status).toBe('stale');
  });
});
