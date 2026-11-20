import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { codebaseSymbolSpanReader } from '../src/anchors/codebase-span-reader.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * #418 with the span source the SAGE daemon uses: the codebase index's symbol reader. A method
 * whose body changes goes stale; one whose class gains unrelated members does not; a name that
 * becomes ambiguous falls back to the name check instead of guessing.
 */

const temps: Array<{ dir: string; store: SqliteSageStore }> = [];

afterEach(async () => {
  for (const entry of temps.splice(0)) {
    entry.store.close();
    await removeProjectFixtureDirectory(entry.dir, { maxRetries: 5, retryDelay: 50 });
  }
});

async function project(source: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-span-index-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  const file = path.join(dir, 'src', 'cart.ts');
  await fs.writeFile(file, source);
  const store = new SqliteSageStore({
    projectRoot: dir,
    symbolSpans: codebaseSymbolSpanReader(dir),
  });
  await store.initialize();
  temps.push({ dir, store });
  const memory = await store.rememberSage({
    text: 'Cart.total applies the discount before tax, per the pricing review',
    kind: 'decision',
    anchors: [{ type: 'symbol', path: 'src/cart.ts', symbol: 'total' }],
  });
  return { store, file, memory };
}

const CART = [
  'export class Cart {',
  '  items: number[] = [];',
  '',
  '  /** Sum after discount, then tax. */',
  '  total(discount: number): number {',
  '    const sum = this.items.reduce((a, b) => a + b, 0);',
  '    return (sum - discount) * 1.2;',
  '  }',
  '}',
  '',
].join('\n');

describe('symbol anchors checked through the codebase index (#418)', () => {
  it('records the method span and goes stale when its body changes', async () => {
    const { store, file, memory } = await project(CART);
    expect(memory.anchors[0]?.spanHash).toMatch(/^span:v1:sha256:/);
    expect([memory.anchors[0]?.lineStart, memory.anchors[0]?.lineEnd]).toEqual([5, 8]);

    await fs.writeFile(file, CART.replace('(sum - discount) * 1.2', 'sum * 1.2 - discount'));

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('stale');
  });

  it('stays verified when the class changes around the method or its doc comment changes', async () => {
    const { store, file } = await project(CART);

    await fs.writeFile(
      file,
      CART.replace(
        '  items: number[] = [];',
        '  items: number[] = [];\n  currency = "EUR";',
      ).replace('Sum after discount, then tax.', 'Discount first, then tax (pricing review).'),
    );

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');
  });

  it('a name that becomes ambiguous falls back to the name check', async () => {
    const { store, file } = await project(CART);

    await fs.writeFile(
      file,
      `${CART.replace('(sum - discount) * 1.2', 'sum')}export class Invoice {\n  total(): number {\n    return 0;\n  }\n}\n`,
    );

    expect((await store.verifyForPaths([file]))[0]?.status).toBe('verified');
  });
});
