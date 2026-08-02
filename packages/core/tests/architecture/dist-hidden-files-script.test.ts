/**
 * WS-070 — CI uploads `packages/*​/dist` and `apps/*​/dist` with
 * `include-hidden-files: true`.
 *
 * That flag is there for a real reason: the lineage manifest lives at
 * `.reports/build-artifact-manifest.json`, which is hidden. But it applies to
 * every path in the upload, so a dotfile that ends up inside any `dist` is
 * swept into an artifact readable by anyone with repo read access.
 *
 * The fix asserts the precondition rather than adding `!**​/.*` exclusions,
 * because mixing include and exclude patterns changes how upload-artifact
 * computes the artifact root — and two jobs download this artifact into `.`
 * and run `check:build-manifest` against the resulting layout. A silent layout
 * shift would break lineage verification in a way that looks unrelated to the
 * change that caused it. An exclusion would also just hide the file rather
 * than surface that the build started emitting it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHiddenEntries } from '../../../../scripts/check-dist-hidden-files.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dist-hidden-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectHiddenEntries (WS-070)', () => {
  it('finds a hidden file at the top level', () => {
    writeFileSync(join(dir, '.env'), 'SECRET=x');
    writeFileSync(join(dir, 'index.js'), '');
    expect(collectHiddenEntries(dir)).toHaveLength(1);
  });

  it('finds a hidden file nested inside ordinary directories', () => {
    mkdirSync(join(dir, 'chunks', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'chunks', 'deep', '.npmrc'), '//registry:_authToken=x');
    expect(collectHiddenEntries(dir)).toHaveLength(1);
  });

  it('reports a hidden DIRECTORY once, not once per file inside it', () => {
    // Otherwise one stray `.cache/` produces hundreds of findings and the
    // failure output becomes unreadable.
    mkdirSync(join(dir, '.cache', 'nested'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'a'), '');
    writeFileSync(join(dir, '.cache', 'b'), '');
    writeFileSync(join(dir, '.cache', 'nested', 'c'), '');
    expect(collectHiddenEntries(dir)).toHaveLength(1);
  });

  it('returns nothing for a clean build directory', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), '');
    writeFileSync(join(dir, 'sub', 'index.d.ts'), '');
    expect(collectHiddenEntries(dir)).toEqual([]);
  });

  it('treats an absent directory as nothing to report, not an error', () => {
    // Not every workspace member builds a dist; a missing one is normal.
    expect(collectHiddenEntries(join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('the check is actually wired up (WS-070)', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('exposes the script through package.json', () => {
    expect(manifest.scripts['check:dist-hidden']).toContain('check-dist-hidden-files.mjs');
  });

  it('runs BEFORE the artifact upload, not after', () => {
    // Running it afterwards would report the problem only once the files had
    // already been published.
    const check = workflow.indexOf('pnpm check:dist-hidden');
    const upload = workflow.indexOf('actions/upload-artifact');
    expect(check).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(-1);
    expect(check).toBeLessThan(upload);
  });

  it('still uploads hidden files deliberately — the flag is the reason for the check', () => {
    // If someone removes the flag, this check becomes unnecessary rather than
    // wrong; pinning it here keeps the two facts connected.
    expect(workflow).toContain('include-hidden-files: true');
  });
});
