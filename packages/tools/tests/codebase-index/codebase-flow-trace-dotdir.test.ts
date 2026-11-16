import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverEntryPoints } from '../../src/codebase-index/codebase-flow-trace-tool.js';

/**
 * The index walk (index-source-files.ts DEFAULT_IGNORE = DEFAULT_WALK_IGNORE_DIRS)
 * is exact-segment, so a directory NAMED '..configs' is a legal indexed in-root dir.
 * Entry discovery must not misread its project-relative paths ('..configs/thing.ts')
 * as parent traversals — a bare startsWith('..') silently dropped every symbol under
 * such directories from traces, while real escapes ('../x', cross-drive) must stay
 * excluded.
 */
describe('discoverEntryPoints: ".."-prefixed in-root dirs', () => {
  const root = path.resolve('flow-trace-dotdir-root');
  const store = {
    getAllSymbols: (): Array<{
      id: number;
      name: string;
      kind: string;
      file: string;
      line: number;
    }> => [
      {
        id: 1,
        name: 'handleThing',
        kind: 'function',
        file: path.join(root, '..configs', 'thing.ts'),
        line: 1,
      },
      {
        id: 2,
        name: 'mainHandler',
        kind: 'function',
        file: path.join(root, 'src', 'main.ts'),
        line: 1,
      },
      {
        id: 3,
        name: 'outsideFn',
        kind: 'function',
        file: path.join(root, '..', '..', 'outside.ts'),
        line: 1,
      },
    ],
    getAllResolvedRefs: (): Array<{ callType: string; fromId: number; toId: number }> => [],
    getFilePackages: (): Map<string, string> => new Map(),
    getFileRankMap: (): Map<string, number> => new Map(),
  };

  it('discovers symbols under ".."-prefixed in-root dirs and still skips real escapes', () => {
    const entries = discoverEntryPoints(store as never, root, { limit: 10 });
    const files = entries.map((e) => e.file);
    expect(files).toContain('..configs/thing.ts');
    expect(files).toContain('src/main.ts');
    // Guard strength: a genuine escape never becomes a candidate.
    expect(files.every((f) => !f.startsWith('../'))).toBe(true);
    expect(entries.map((e) => e.symbol)).not.toContain('outsideFn');
  });
});
