/**
 * Source-text regression guard for the vector-memory wiring through
 * `runCliExecution` — the builder hop between `cli-main.ts` (which
 * constructs the store) and `execute()` (which threads it into the
 * embedded WebUI dispatch).
 *
 * The regression this pins: during the 2026-08-14 decomposition the
 * builder declared `vectorMemoryStore` / `vectorMemoryModelCacheDir`
 * in its params type but omitted them from BOTH the destructure block
 * and the `toExecuteDeps({ session: { … } })` assembly. The fields are
 * optional in `ExecuteDeps`, so TypeScript stayed silent, and the
 * embedded WebUI answered `/api/vector-memory/status` with
 * `{ enabled: false }` ("Vector Memory Disabled" panel) even though the
 * store constructed fine upstream.
 *
 * Presence-only assertions would NOT catch that bug — the identifiers
 * were present in the file the whole time (in the `vectorMemoryStore:
 * any;` params declaration). So every check below is anchored to the
 * exact region that must carry the wiring, and matches the bare
 * shorthand form (`vectorMemoryStore,`) which never appears in the
 * type declaration.
 *
 * Mirrors the `start-webui.ts source-text wiring` describe block in
 * packages/webui-server/tests/start-webui-vector-memory.integration.test.ts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const builderPath = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'wiring',
  'cli-execute-builder.ts',
);

/** The shorthand property form — distinct from `vectorMemoryStore: any;`. */
const STORE_SHORTHAND = 'vectorMemoryStore,';
const CACHE_DIR_SHORTHAND = 'vectorMemoryModelCacheDir,';

describe('cli-execute-builder.ts source-text wiring', () => {
  it('destructures vectorMemoryStore and vectorMemoryModelCacheDir from params', async () => {
    const source = await fs.readFile(builderPath, 'utf8');

    // Anchor: the single `} = params;` closing the destructure block.
    // The window spans ~2500 chars above it — enough to cover the whole
    // flat identifier list (≈1700 chars today) while tolerating minor
    // edits. If the block grows past this reach, the test fails and the
    // wiring should be re-checked by hand.
    const paramsEnd = source.indexOf('} = params;');
    expect(paramsEnd).toBeGreaterThan(-1);
    const destructureWindow = source.slice(Math.max(0, paramsEnd - 2_500), paramsEnd);
    expect(destructureWindow).toContain(STORE_SHORTHAND);
    expect(destructureWindow).toContain(CACHE_DIR_SHORTHAND);
  });

  it('threads both fields into the toExecuteDeps session group', async () => {
    const source = await fs.readFile(builderPath, 'utf8');

    // Anchor: the single `toExecuteDeps({` call that assembles the deps
    // object consumed by `execute()`.
    const depsIdx = source.indexOf('toExecuteDeps({');
    expect(depsIdx).toBeGreaterThan(-1);
    const depsWindow = source.slice(depsIdx, depsIdx + 6_000);

    // The fields must land inside the `session: { … }` group — the exact
    // group `execute()` reads `deps.session.vectorMemoryStore` from.
    // Putting them in any other group (e.g. `core:`) is the same
    // regression with a different face, so bound the check between the
    // `session: {` opener and the next sibling group opener.
    const sessionIdx = depsWindow.indexOf('session: {');
    expect(sessionIdx).toBeGreaterThan(-1);
    const nextGroupIdx = depsWindow.indexOf('provider: {', sessionIdx);
    expect(nextGroupIdx).toBeGreaterThan(sessionIdx);
    const sessionGroup = depsWindow.slice(sessionIdx, nextGroupIdx);
    expect(sessionGroup).toContain(STORE_SHORTHAND);
    expect(sessionGroup).toContain(CACHE_DIR_SHORTHAND);
  });
});
