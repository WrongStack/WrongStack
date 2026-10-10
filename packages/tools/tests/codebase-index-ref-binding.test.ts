import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';
/**
 * Import-aware binding of JS/TS refs (ref-binding-pass.ts).
 *
 * Name-only resolution sent every `it(…)` in a test file to whatever project
 * symbol named `it` had the lowest id, and a call into a module to the
 * lowest-id homonym rather than the declaration the file imports. These pin
 * the binding rules and the cases where a narrow run must reach refs owned by
 * files it did not rewrite.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const DatabaseSync = loadTestDatabaseSync();

import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { MODULE_OWNER_NAME } from '../src/codebase-index/schema.js';
import { IndexStore } from '../src/codebase-index/writer.js';

const ctx = {} as Context;
let root: string;
let indexDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ref-bind-'));
  indexDir = path.join(root, '.idx');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

function query<T>(sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(path.join(indexDir, 'index.db'));
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

interface Binding {
  /** File declaring the symbol `to_id` names, relative; null when unbound. */
  target: string | null;
  toFile: string | null;
}

/** Where the `callType` refs to `name` made from `fromRelative` point. */
function bindingsOf(fromRelative: string, name: string, callType = 'call'): Binding[] {
  return query<{ target: string | null; toFile: string | null }>(
    `SELECT t.file AS target, r.to_file AS toFile
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       LEFT JOIN symbols t ON t.id = r.to_id
      WHERE s.file = ? AND r.to_name = ? AND r.call_type = ?
      ORDER BY r.line`,
    path.join(root, fromRelative),
    name,
    callType,
  ).map((row) => ({
    target: row.target ? path.relative(root, row.target) : null,
    toFile: row.toFile ? path.relative(root, row.toFile) : row.toFile,
  }));
}

const rel = (...parts: string[]) => path.join(...parts);
const index = (files?: string[]) => runIndexer(ctx, { projectRoot: root, indexDir, files });

describe('import-aware ref binding', () => {
  it('binds a name imported from outside the project to nothing', async () => {
    // `a-locale.ts` sorts first, so its `it` holds the lowest id.
    await write('src/a-locale.ts', 'export const it = { hello: "ciao" };\n');
    await write(
      'src/b.test.ts',
      "import { it } from 'vitest';\nexport function suite() { it('works', () => 1); }\n",
    );
    await index();

    expect(bindingsOf('src/b.test.ts', 'it')).toEqual([{ target: null, toFile: '' }]);
    expect(bindingsOf('src/b.test.ts', 'it', 'import')).toEqual([{ target: null, toFile: null }]);
  });

  it('keeps the external binding when a targeted run re-resolves the name', async () => {
    const locale = await write('src/a-locale.ts', 'export const it = 1;\n');
    await write(
      'src/b.test.ts',
      "import { it } from 'vitest';\nexport function suite() { it('works', () => 1); }\n",
    );
    await index();

    // Rewriting the homonym's file NULLs and re-resolves every ref by name.
    await fs.writeFile(locale, '// moved\nexport const it = 2;\n');
    await index([locale]);

    expect(bindingsOf('src/b.test.ts', 'it')).toEqual([{ target: null, toFile: '' }]);
  });

  it('prefers a same-file top-level declaration over a lower-id homonym', async () => {
    await write('src/a.ts', 'export function helper() { return 1; }\n');
    await write(
      'src/b.ts',
      'function helper() { return 2; }\nexport function run() { return helper(); }\n',
    );
    await index();

    expect(bindingsOf('src/b.ts', 'helper')).toEqual([
      { target: rel('src', 'b.ts'), toFile: rel('src', 'b.ts') },
    ]);
  });

  it('follows named and wildcard re-exports to the declaration', async () => {
    await write('src/a-other.ts', 'export function target() { return 0; }\n');
    await write('src/impl.ts', 'export function target() { return 1; }\n');
    await write('src/barrel.ts', "export { target } from './impl';\n");
    await write('src/index.ts', "export * from './barrel';\n");
    await write(
      'src/use.ts',
      "import { target } from './index';\nexport const go = () => target();\n",
    );
    await index();

    const impl = rel('src', 'impl.ts');
    expect(bindingsOf('src/use.ts', 'target')).toEqual([{ target: impl, toFile: impl }]);
    expect(bindingsOf('src/use.ts', 'target', 'import')).toEqual([
      { target: impl, toFile: rel('src', 'index.ts') },
    ]);
  });

  it('rebinds the importers of a file a targeted run rewrote', async () => {
    await write('src/a-other.ts', 'export function target() { return 0; }\n');
    const impl = await write('src/impl.ts', 'export function target() { return 1; }\n');
    await write(
      'src/use.ts',
      "import { target } from './impl';\nexport const go = () => target();\n",
    );
    await index();

    // New symbol ids for impl.ts; the name guess alone would land on a-other.
    await fs.writeFile(impl, 'export const before = 0;\nexport function target() { return 2; }\n');
    await index([impl]);

    const implRel = rel('src', 'impl.ts');
    expect(bindingsOf('src/use.ts', 'target')).toEqual([{ target: implRel, toFile: implRel }]);
  });

  it('binds an import once its target file appears in a targeted run', async () => {
    await write('src/a-other.ts', 'export function late() { return 0; }\n');
    await write('src/use.ts', "import { late } from './late';\nexport const go = () => late();\n");
    await index();
    // Unresolved relative import: nothing in the project is known to be it.
    expect(bindingsOf('src/use.ts', 'late')).toEqual([{ target: null, toFile: '' }]);

    const late = await write('src/late.ts', 'export function late() { return 1; }\n');
    await index([late]);

    const lateRel = rel('src', 'late.ts');
    expect(bindingsOf('src/use.ts', 'late')).toEqual([{ target: lateRel, toFile: lateRel }]);
  });

  it('returns an untouched importer to the name guess once its export is gone', async () => {
    await write('src/a-other.ts', 'export function helper() { return 0; }\n');
    const lib = await write('src/lib.ts', 'export function helper() { return 1; }\n');
    await write(
      'src/use.ts',
      "import { helper } from './lib';\nexport const go = () => helper();\n",
    );
    await index();
    expect(bindingsOf('src/use.ts', 'helper')).toEqual([
      { target: rel('src', 'lib.ts'), toFile: rel('src', 'lib.ts') },
    ]);

    // lib.ts stops declaring `helper`; use.ts is not re-parsed. Its ref must
    // not keep claiming lib.ts while the name guess points elsewhere.
    await fs.writeFile(lib, 'export function other() { return 1; }\n');
    await index([lib]);

    expect(bindingsOf('src/use.ts', 'helper')).toEqual([
      { target: rel('src', 'a-other.ts'), toFile: null },
    ]);
  });

  it('leaves a no-op run without writes', async () => {
    await write('src/impl.ts', 'export function target() { return 1; }\n');
    await write(
      'src/use.ts',
      "import { target } from './impl';\nexport const go = () => target();\n",
    );
    await index();

    const result = await index();

    expect(result.changedFiles).toBe(0);
    expect(result.contentChanged).toBe(false);
  });

  it('excludes externally bound refs from the incoming-calls name fallback', async () => {
    await write('src/a-locale.ts', 'export const it = 1;\n');
    await write(
      'src/b.test.ts',
      "import { it } from 'vitest';\nexport function suite() { it('works', () => 1); }\n",
    );
    await index();

    const store = new IndexStore(root, { indexDir });
    try {
      const incoming = store.findIncomingCallsByName('it', undefined, 50);
      expect(incoming.calls.map((call) => path.relative(root, call.symbol.file))).not.toContain(
        rel('src', 'b.test.ts'),
      );
    } finally {
      store.close();
    }
  });
});

describe('symbol-less files', () => {
  const testFile = "import { helper } from './lib';\ndescribe('x', () => { helper(); });\n";

  it('keeps the imports and calls of a file that declares nothing', async () => {
    await write('src/lib.ts', 'export function helper() { return 1; }\n');
    await write('src/lib.test.ts', testFile);
    await write('src/barrel.ts', "export * from './lib';\n");
    await index();

    const lib = rel('src', 'lib.ts');
    expect(bindingsOf('src/lib.test.ts', 'helper')).toEqual([{ target: lib, toFile: lib }]);
    expect(bindingsOf('src/barrel.ts', './lib', 'import')).toEqual([{ target: null, toFile: lib }]);
  });

  it('re-parses the symbol-less files of an index built before they owned refs', async () => {
    await write('src/lib.ts', 'export function helper() { return 1; }\n');
    await write('src/lib.test.ts', testFile);
    await index();
    // What an older build left: no owner, no refs, a trusted content stamp.
    const db = new DatabaseSync(path.join(indexDir, 'index.db'));
    try {
      db.exec(`DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE kind = 'mod');
               DELETE FROM symbols WHERE kind = 'mod';
               UPDATE files SET symbol_count = 0 WHERE file LIKE '%lib.test.ts';
               DELETE FROM metadata WHERE key = 'module_owner_version';`);
    } finally {
      db.close();
    }
    expect(bindingsOf('src/lib.test.ts', 'helper')).toEqual([]);

    await index();

    const lib = rel('src', 'lib.ts');
    expect(bindingsOf('src/lib.test.ts', 'helper')).toEqual([{ target: lib, toFile: lib }]);
  });

  it('keeps file owners out of symbol search', async () => {
    await write('src/lib.ts', 'export function helper() { return 1; }\n');
    await write('src/lib.test.ts', testFile);
    await write('src/module.ts', 'export const moduleName = "x";\n');
    await index();

    const store = new IndexStore(root, { indexDir });
    try {
      // Long tokens take the FTS path, short ones the LIKE fallback.
      for (const query of ['module', 'mod', 'od', '']) {
        const names = store.search(query, {}, { limit: 50 }).map((hit) => hit.name);
        expect(names, query).not.toContain(MODULE_OWNER_NAME);
      }
    } finally {
      store.close();
    }
  });
});
