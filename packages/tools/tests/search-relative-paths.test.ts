import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRootRelativizer } from '../src/_util.js';
import { globTool } from '../src/glob.js';
import { __resetRgDetectionForTests, __setRgAvailableForTests, grepTool } from '../src/grep.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

const isWin = process.platform === 'win32';
/** Compare on forward slashes so one assertion covers both separators. */
const norm = (p: string): string => p.split(path.sep).join('/');
const REL = 'src/nested/hit.ts';

/**
 * The search tools used to emit absolute paths, repeating the project prefix
 * on every one of up to 2000 (grep) / 5000 (glob) result lines. These lock in
 * the root-relative form for BOTH grep engines — rg formats its own output
 * lines while the native fallback builds them by hand, and the two diverged
 * silently before.
 */
describe('search tools emit project-root-relative paths', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
    await fs.mkdir(path.join(sb.dir, 'src', 'nested'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'nested', 'hit.ts'), 'const needle = 1;\n');
    await fs.mkdir(path.join(sb.dir, 'packages', 'app', 'dist', 'nested'), { recursive: true });
    await fs.writeFile(
      path.join(sb.dir, 'packages', 'app', 'dist', 'nested', 'generated.js'),
      'const needle = 1;\n',
    );
  });
  afterEach(async () => {
    __resetRgDetectionForTests();
    await sb.cleanup();
  });

  for (const engine of ['rg', 'native'] as const) {
    describe(`${engine} engine`, () => {
      beforeEach(() => {
        __setRgAvailableForTests(engine === 'rg');
      });

      it('content mode strips the root prefix but keeps line and text', async () => {
        const out = await grepTool.execute({ pattern: 'needle' }, sb.ctx, {
          signal: newSignal(),
        });
        if (out.used !== engine) return; // rg genuinely absent on this machine
        const hit = out.matches.find((m) => m.includes('hit.ts'));
        expect(hit).toBeDefined();
        expect(hit!.startsWith(sb.dir)).toBe(false);
        expect(norm(hit!)).toBe(`${REL}:1:const needle = 1;`);
      });

      it('files_with_matches mode strips the root prefix', async () => {
        const out = await grepTool.execute(
          { pattern: 'needle', output_mode: 'files_with_matches' },
          sb.ctx,
          { signal: newSignal() },
        );
        if (out.used !== engine) return;
        const hit = out.matches.find((m) => m.includes('hit.ts'));
        expect(hit).toBeDefined();
        expect(norm(hit!)).toBe(REL);
      });

      it('count mode keeps the trailing count after stripping', async () => {
        const out = await grepTool.execute({ pattern: 'needle', output_mode: 'count' }, sb.ctx, {
          signal: newSignal(),
        });
        if (out.used !== engine) return;
        const hit = out.matches.find((m) => m.includes('hit.ts'));
        expect(hit).toBeDefined();
        expect(norm(hit!)).toBe(`${REL}:1`);
        expect(out.count).toBe(1);
      });

      it('an explicit sub-path is still reported from the project root', async () => {
        const out = await grepTool.execute({ pattern: 'needle', path: 'src' }, sb.ctx, {
          signal: newSignal(),
        });
        if (out.used !== engine) return;
        const hit = out.matches.find((m) => m.includes('hit.ts'));
        expect(hit).toBeDefined();
        // Not `nested/hit.ts`: paths stay comparable across calls regardless of
        // which sub-directory the search happened to be scoped to.
        expect(norm(hit!).startsWith(`${REL}:`)).toBe(true);
      });

      it('does not search an explicitly targeted dist directory or file below it', async () => {
        const directoryResult = await grepTool.execute(
          { pattern: 'needle', path: 'packages/app/dist' },
          sb.ctx,
          { signal: newSignal() },
        );
        const fileResult = await grepTool.execute(
          { pattern: 'needle', path: 'packages/app/dist/nested/generated.js' },
          sb.ctx,
          { signal: newSignal() },
        );

        expect(directoryResult).toEqual({
          matches: [],
          count: 0,
          truncated: false,
          used: engine,
        });
        expect(fileResult).toEqual({
          matches: [],
          count: 0,
          truncated: false,
          used: engine,
        });
      });
    });
  }

  it('glob emits root-relative files', async () => {
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.length).toBeGreaterThanOrEqual(1);
    for (const f of out.files) expect(path.isAbsolute(f)).toBe(false);
    expect(out.files.map(norm)).toContain(REL);
  });

  it('glob with explicit path option matches pattern and returns root-relative files', async () => {
    const out = await globTool.execute({ pattern: '**/*.ts', path: 'src' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.files.length).toBeGreaterThanOrEqual(1);
    for (const f of out.files) expect(path.isAbsolute(f)).toBe(false);
    expect(out.files.map(norm)).toContain(REL);
  });
});

describe('makeRootRelativizer', () => {
  const root = isWin ? path.join('C:', path.sep, 'proj', 'root') : '/proj/root';

  it('strips the root prefix', () => {
    const rel = makeRootRelativizer(root);
    expect(rel(path.join(root, 'a', 'b.ts'))).toBe(path.join('a', 'b.ts'));
  });

  it('leaves paths outside the root absolute rather than emitting ../ chains', () => {
    // `safeResolveReal` also admits `~/.wrongstack`; a relative path to there
    // would be longer and far less readable than the absolute one.
    const rel = makeRootRelativizer(root);
    const outside = isWin ? path.join('C:', path.sep, 'elsewhere', 'x.ts') : '/elsewhere/x.ts';
    expect(rel(outside)).toBe(outside);
  });

  it('does not strip a sibling that shares the root as a name prefix', () => {
    const rel = makeRootRelativizer(root);
    const sibling = `${root}-backup${path.sep}x.ts`;
    expect(rel(sibling)).toBe(sibling);
  });

  it('returns the root itself unchanged', () => {
    const rel = makeRootRelativizer(root);
    expect(rel(root)).toBe(root);
  });

  it.runIf(isWin)('compares drive letters case-insensitively', () => {
    const root2 = path.join('C:', path.sep, 'proj', 'root');
    const rel = makeRootRelativizer(root2);
    expect(rel(path.join(root2.toLowerCase(), 'a.ts'))).toBe('a.ts');
  });
});
