/**
 * Import-aware binding of JS/TS references.
 *
 * Ref resolution proper (`resolveRefs*` in writer-refs.ts) is a name-only
 * guess: `to_id` is the lowest symbol id declaring `to_name` anywhere in the
 * language family. For a TypeScript codebase that is wrong exactly where it
 * matters — every `it(…)` in three thousand test files resolved to the one
 * `const it` in the Italian locale table, `path`/`fs` to whichever script
 * declared them, and a call into a module landed on the lowest-id homonym
 * instead of the declaration the file imports. This pass rebinds the refs of
 * the JS family using what the file itself says:
 *
 * 1. a top-level declaration of the name in the same file;
 * 2. else the file's import of the name, followed into the resolved module
 *    (`refs.to_file`) and through re-exports (`export { X } from`,
 *    `export * from`) up to {@link MAX_REEXPORT_HOPS} files;
 * 3. an import from outside the index (`vitest`, `node:path`, an unresolved
 *    relative path) binds the name to nothing: `to_id` NULL, `to_file` ''.
 *    The name-based resolvers skip that marker, so a later run cannot
 *    re-guess a homonym for it;
 * 4. otherwise the name-based answer stands (globals, ambient declarations).
 *
 * A precisely bound non-import ref records its target's file in `to_file`,
 * which the incoming-calls reader already uses as disambiguation evidence.
 * Import refs keep their module `to_file` (the relation pass owns it); only
 * their `to_id` is bound here, and the name resolvers leave JS import refs to
 * this pass entirely.
 *
 * Aliased imports (`import { X as Y }`) are recorded under the original name,
 * so calls through the alias keep the name-based answer; namespace imports
 * bind the namespace name, which declares nothing, and fall through likewise.
 *
 * A run rebinds what it can have changed, not whole files: every ref of a
 * re-parsed file, and elsewhere only the refs named like one that pointed
 * into a changed file (see {@link planRefBinding}). A consumer whose binding
 * routes THROUGH a changed barrel to an unchanged declaring file is not
 * revisited; redirecting such a re-export without touching its consumers is
 * rare, and a version bump rebinds everything.
 */

import { detectLang, languageFamily } from './languages.js';
import { allRowsAsArrays } from './sqlite-runtime.js';
import { inListChunks, padToInBucket, placeholders } from './writer-helpers.js';

/** Bump when binding rules change: every index rebinds once. */
export const REF_BINDING_VERSION = '2';
export const REF_BINDING_VERSION_KEY = 'ref_binding_version';

/** Re-export hops followed from an importer before giving up. */
const MAX_REEXPORT_HOPS = 4;

/** Language families that do not participate in symbol reference binding. */
const NON_BINDABLE_FAMILIES: ReadonlySet<string> = new Set(['data', 'web', 'other']);

export function isJsFamilyFile(file: string): boolean {
  const lang = detectLang(file);
  return lang !== null && languageFamily(lang) === 'js';
}

export function isBindableFile(file: string): boolean {
  const lang = detectLang(file);
  return lang !== null && !NON_BINDABLE_FAMILIES.has(languageFamily(lang));
}

type Stmt = {
  all: (...args: never[]) => unknown[];
  run: (...args: never[]) => unknown;
};
type StmtFn = (sql: string) => Stmt;

export interface RefBindingStore {
  stmt: StmtFn;
  maxSqlVars: number;
  /** Runs `operation` in one write transaction. */
  write: (operation: () => void) => void;
}

/** What a narrow run rebinds. */
export interface RefBindingScope {
  /** Files whose every ref is rebound (their rows are new this run). */
  files: ReadonlySet<string>;
  /** Other files: only their refs to these names. */
  names: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface RefBindingResult {
  files: number;
  refs: number;
  bound: number;
  external: number;
  updated: number;
}

interface RefRow {
  id: number;
  file: string;
  toName: string;
  toId: number | null;
  callType: string;
  module: string | null;
  toFile: string | null;
}

/** [to_name, module, to_file] of one import/re-export ref. */
type ImportFact = [string, string | null, string | null];

interface FileFacts {
  /** Top-level declarations: name → lowest symbol id. */
  declared: Map<string, number>;
  imports: ImportFact[];
  /**
   * Where a name may be forwarded from, built on first use: resolved
   * import/re-export targets by name, and wildcard (module-only) targets.
   * A barrel carries hundreds of re-exports; scanning them per lookup was
   * most of an edit's binding cost.
   */
  forward?: { byName: Map<string, string[]>; wildcard: string[] };
}

type Binding = { kind: 'file'; file: string } | { kind: 'external' };

const REF_COLUMNS = `SELECT r.id, s.file, r.to_name, r.to_id, r.call_type, r.module, r.to_file
       FROM refs r JOIN symbols s ON s.id = r.from_id`;

/** Run `sql(ph)` over `values` in IN-list chunks, collecting array rows. */
function chunkedRows(
  store: RefBindingStore,
  values: readonly string[],
  sql: (ph: string) => string,
): unknown[][] {
  const out: unknown[][] = [];
  let cursor = 0;
  for (const n of inListChunks(values.length, store.maxSqlVars)) {
    const bucket = padToInBucket(values.slice(cursor, cursor + n));
    cursor += n;
    const rows = allRowsAsArrays(
      store.stmt(sql(placeholders(bucket.length))),
      ...(bucket as never[]),
    );
    for (const row of rows) out.push(row);
  }
  return out;
}

/**
 * Rows for (file, name) pairs: `sql(filePh, namePh)` over the cross product
 * of file and name chunks, filtered to the pairs asked for. Both lists are
 * narrow — the owners and names of refs into a changed file — so the
 * superset SQL returns is small.
 */
function pairRows(
  store: RefBindingStore,
  pairs: ReadonlyMap<string, ReadonlySet<string>>,
  sql: (filePh: string, namePh: string) => string,
  fileCol: number,
  nameCol: number,
): unknown[][] {
  const files = [...pairs.keys()];
  const names = [...new Set([...pairs.values()].flatMap((set) => [...set]))];
  if (files.length === 0 || names.length === 0) return [];
  const half = Math.max(1, Math.floor(store.maxSqlVars / 2));
  const out: unknown[][] = [];
  let fileCursor = 0;
  for (const fn of inListChunks(files.length, half)) {
    const fileBucket = padToInBucket(files.slice(fileCursor, fileCursor + fn));
    fileCursor += fn;
    let nameCursor = 0;
    for (const nn of inListChunks(names.length, half)) {
      const nameBucket = padToInBucket(names.slice(nameCursor, nameCursor + nn));
      nameCursor += nn;
      const rows = allRowsAsArrays(
        store.stmt(sql(placeholders(fileBucket.length), placeholders(nameBucket.length))),
        ...([...fileBucket, ...nameBucket] as never[]),
      );
      for (const row of rows) {
        if (pairs.get(row[fileCol] as string)?.has(row[nameCol] as string)) out.push(row);
      }
    }
  }
  return out;
}

/**
 * Rebind the JS-family refs `scope` names (or every one). SQL errors
 * propagate so the index run records them.
 */
export function bindRefsByImports(
  store: RefBindingStore,
  scope: RefBindingScope | 'all',
): RefBindingResult {
  const result: RefBindingResult = { files: 0, refs: 0, bound: 0, external: 0, updated: 0 };
  const whole = scope === 'all';
  const wholeFiles = whole ? [] : [...scope.files].filter(isBindableFile);
  const pairs = new Map<string, ReadonlySet<string>>();
  if (!whole) {
    for (const [file, names] of scope.names) {
      if (!scope.files.has(file) && isBindableFile(file)) pairs.set(file, names);
    }
    if (wholeFiles.length === 0 && pairs.size === 0) return result;
  }

  // ── The refs being rebound ────────────────────────────────────────────
  const refs: RefRow[] = [];
  const bindableFile = new Map<string, boolean>();
  const jsFile = new Map<string, boolean>();
  const isJs = (file: string): boolean => {
    let v = jsFile.get(file);
    if (v === undefined) {
      v = isJsFamilyFile(file);
      jsFile.set(file, v);
    }
    return v;
  };
  const pushRows = (rows: unknown[][]) => {
    for (const [id, file, toName, toId, callType, module, toFile] of rows as Array<
      [number, string, string, number | null, string, string | null, string | null]
    >) {
      let ok = bindableFile.get(file);
      if (ok === undefined) {
        ok = isBindableFile(file);
        bindableFile.set(file, ok);
      }
      if (!ok) continue;
      refs.push({ id, file, toName, toId, callType, module, toFile });
    }
  };
  if (whole) {
    pushRows(allRowsAsArrays(store.stmt(REF_COLUMNS)));
  } else {
    pushRows(chunkedRows(store, wholeFiles, (ph) => `${REF_COLUMNS} WHERE s.file IN (${ph})`));
    pushRows(
      pairRows(
        store,
        pairs,
        (fph, nph) => `${REF_COLUMNS} WHERE s.file IN (${fph}) AND r.to_name IN (${nph})`,
        1,
        2,
      ),
    );
  }
  result.refs = refs.length;
  if (refs.length === 0) return result;
  result.files = new Set(refs.map((ref) => ref.file)).size;

  // ── Facts ────────────────────────────────────────────────────────────
  // `facts`: complete per-file facts, for files an export is looked up in.
  // `owners`: what the rebound refs' own files declare and import — whole
  // for re-parsed files, narrowed to the scoped names for the rest.
  const facts = new Map<string, FileFacts>();
  const owners = new Map<string, FileFacts>();
  /** Declaring file of every symbol id loaded. */
  const fileOfSymbol = new Map<number, string>();
  const factsIn = (map: Map<string, FileFacts>, file: string): FileFacts => {
    let f = map.get(file);
    if (f === undefined) {
      f = { declared: new Map(), imports: [] };
      map.set(file, f);
    }
    return f;
  };
  const declare = (map: Map<string, FileFacts>, rows: unknown[][]) => {
    for (const [file, name, id] of rows as Array<[string, string, number | null]>) {
      if (id === null) continue;
      factsIn(map, file).declared.set(name, id);
      fileOfSymbol.set(id, file);
    }
  };
  // For JS-family files, only top-level (`scope = ''`) symbols are file-scope
  // declarations. For non-JS languages (Python, Go, Rust, Java, C/C++, C#,
  // PHP, Ruby, etc.), parsers qualify `scope` with the module/package/namespace
  // name, so we include non-`mod` declarations while preferring top-level
  // functions/types/classes over class methods/fields.
  const SYMBOL_COLUMNS = `SELECT file, name,
    COALESCE(
      MIN(CASE WHEN kind NOT IN ('method', 'property', 'field', 'ctor', 'namespace') THEN id END),
      MIN(id)
    )
    FROM symbols
   WHERE kind != 'mod'
     AND (scope = '' OR lang NOT IN ('ts', 'tsx', 'js', 'jsx', 'vue', 'svelte'))`;
  const IMPORT_COLUMNS = `SELECT s.file, r.to_name, r.module, r.to_file
         FROM refs r JOIN symbols s ON s.id = r.from_id
        WHERE +r.call_type = 'import'`;
  const loaded = new Set<string>();
  const loadFacts = (files: readonly string[]): void => {
    const fresh = files.filter((file) => !loaded.has(file));
    if (fresh.length === 0) return;
    for (const file of fresh) {
      loaded.add(file);
      factsIn(facts, file);
    }
    declare(
      facts,
      chunkedRows(
        store,
        fresh,
        (ph) => `${SYMBOL_COLUMNS} AND file IN (${ph}) GROUP BY file, name`,
      ),
    );
    for (const [file, toName, module, toFile] of chunkedRows(
      store,
      fresh,
      (ph) => `${IMPORT_COLUMNS} AND s.file IN (${ph})`,
    ) as Array<[string, string, string | null, string | null]>) {
      factsIn(facts, file).imports.push([toName, module, toFile]);
    }
  };

  if (whole) {
    declare(facts, allRowsAsArrays(store.stmt(`${SYMBOL_COLUMNS} GROUP BY file, name`)));
    for (const [file, toName, module, toFile] of allRowsAsArrays(
      store.stmt(IMPORT_COLUMNS),
    ) as Array<[string, string, string | null, string | null]>) {
      factsIn(facts, file).imports.push([toName, module, toFile]);
    }
  } else {
    // Declarations: all of a re-parsed file's, only the scoped names of the rest.
    declare(
      owners,
      chunkedRows(
        store,
        wholeFiles,
        (ph) => `${SYMBOL_COLUMNS} AND file IN (${ph}) GROUP BY file, name`,
      ),
    );
    declare(
      owners,
      pairRows(
        store,
        pairs,
        (fph, nph) =>
          `${SYMBOL_COLUMNS} AND file IN (${fph}) AND name IN (${nph}) GROUP BY file, name`,
        0,
        1,
      ),
    );
    // Imports: the rebound refs hold every import for `wholeFiles`, and for
    // non-JS `pairs` files a header/package import has a different `to_name`
    // than the symbol called, so load all imports of `pairs` files too.
    for (const ref of refs) {
      if (ref.callType === 'import' && !pairs.has(ref.file)) {
        factsIn(owners, ref.file).imports.push([ref.toName, ref.module, ref.toFile]);
      }
    }
    const pairFiles = [...pairs.keys()];
    if (pairFiles.length > 0) {
      for (const [file, toName, module, toFile] of chunkedRows(
        store,
        pairFiles,
        (ph) => `${IMPORT_COLUMNS} AND s.file IN (${ph})`,
      ) as Array<[string, string, string | null, string | null]>) {
        factsIn(owners, file).imports.push([toName, module, toFile]);
      }
    }
    // Direct import targets in one batch; deeper re-export hops load on demand.
    const targets = new Set<string>();
    for (const f of owners.values())
      for (const [, , toFile] of f.imports) if (toFile) targets.add(toFile);
    loadFacts([...targets]);
  }
  const ownerFacts = (file: string): FileFacts | undefined =>
    whole ? facts.get(file) : owners.get(file);

  const forwardOf = (f: FileFacts): NonNullable<FileFacts['forward']> => {
    if (f.forward) return f.forward;
    const byName = new Map<string, string[]>();
    const wildcard: string[] = [];
    for (const [toName, module, toFile] of f.imports) {
      if (!toFile) continue;
      if (toName === module) wildcard.push(toFile);
      else {
        const list = byName.get(toName);
        if (list) list.push(toFile);
        else byName.set(toName, [toFile]);
      }
    }
    f.forward = { byName, wildcard };
    return f.forward;
  };
  /** Symbol `name` as exported by `file`, following re-exports. */
  const findExport = (file: string, name: string): number | undefined => {
    const seen = new Set<string>();
    let frontier = [file];
    for (let hop = 0; hop <= MAX_REEXPORT_HOPS && frontier.length > 0; hop++) {
      if (!whole) loadFacts(frontier);
      const next: string[] = [];
      for (const current of frontier) {
        if (seen.has(current)) continue;
        seen.add(current);
        const f = facts.get(current);
        if (!f) continue;
        const id = f.declared.get(name);
        if (id !== undefined) return id;
        // `export { name } from`, or a wildcard/side-effect module ref.
        const { byName, wildcard } = forwardOf(f);
        const named = byName.get(name);
        if (named) for (const target of named) next.push(target);
        for (const target of wildcard) next.push(target);
      }
      frontier = next;
    }
    return undefined;
  };
  const exportMemo = new Map<string, number | null>();
  const exportedId = (file: string, name: string): number | undefined => {
    const key = `${file}\u0000${name}`;
    const memo = exportMemo.get(key);
    if (memo !== undefined) return memo ?? undefined;
    const id = findExport(file, name);
    exportMemo.set(key, id ?? null);
    return id;
  };

  // name → binding, per importing file.
  const bindingsOf = new Map<string, Map<string, Binding>>();
  const bindings = (file: string): Map<string, Binding> => {
    let map = bindingsOf.get(file);
    if (map !== undefined) return map;
    map = new Map();
    const js = isJs(file);
    const lang = detectLang(file);
    for (const [toName, module, toFile] of ownerFacts(file)?.imports ?? []) {
      if (module === null || toName === module) continue; // module-only ref binds no name
      if (toFile) {
        map.set(toName, { kind: 'file', file: toFile });
      } else if (!map.has(toName)) {
        // In JS, any `import { X } from 'pkg'` with no resolved project file is
        // an external binding. In Python, `from pkg import X` (where `toName`
        // is the imported symbol, not the trailing segment of `import pkg.sub`)
        // is likewise an explicit external symbol binding.
        const isPyNamedImport =
          lang === 'py' && !module.startsWith('.') && toName !== module.split('.').pop();
        if (js || isPyNamedImport) {
          map.set(toName, { kind: 'external' });
        }
      }
    }
    bindingsOf.set(file, map);
    return map;
  };

  // ── Decide ───────────────────────────────────────────────────────────
  const updates: Array<[number | null, string | null, number]> = [];
  const needFallback: RefRow[] = [];
  for (const ref of refs) {
    const js = isJs(ref.file);
    if (ref.callType === 'import') {
      if (ref.module === null || ref.toName === ref.module) continue;
      if (js) {
        let toId: number | null = null;
        if (ref.toFile) toId = exportedId(ref.toFile, ref.toName) ?? null;
        if (toId !== null) result.bound++;
        else if (!ref.toFile) result.external++;
        if (toId !== ref.toId) updates.push([toId, ref.toFile, ref.id]);
      } else if (ref.toFile) {
        const id = exportedId(ref.toFile, ref.toName);
        if (id !== undefined) {
          result.bound++;
          if (id !== ref.toId) updates.push([id, ref.toFile, ref.id]);
        }
      }
      continue;
    }
    const local = ownerFacts(ref.file)?.declared.get(ref.toName);
    let toId: number | null | undefined;
    let toFile: string | null | undefined;
    if (local !== undefined) {
      toId = local;
      toFile = ref.file;
    } else {
      const binding = bindings(ref.file).get(ref.toName);
      if (binding?.kind === 'external') {
        toId = null;
        toFile = '';
      } else if (binding?.kind === 'file') {
        const id = exportedId(binding.file, ref.toName);
        if (id !== undefined) {
          toId = id;
          toFile = fileOfSymbol.get(id) ?? binding.file;
        }
      }
      // For non-JS languages (C/C++ `#include "b.h"`, Go `import "pkg/sub"`,
      // Python `import mod`, Ruby `require_relative`, C# `using Ns`, Java),
      // module/header/namespace imports resolve `toFile` on the import ref
      // while calls reference symbols exported by that `toFile`.
      if (toId === undefined && !js) {
        for (const [, , impFile] of ownerFacts(ref.file)?.imports ?? []) {
          if (!impFile) continue;
          const id = exportedId(impFile, ref.toName);
          if (id !== undefined) {
            toId = id;
            toFile = fileOfSymbol.get(id) ?? impFile;
            break;
          }
        }
      }
    }
    if (toId === undefined) {
      // No evidence: the name-based answer stands — unless this ref still
      // carries a binding from an earlier run, which must be undone.
      if (ref.toFile !== null) needFallback.push(ref);
      continue;
    }
    if (toId === null) result.external++;
    else result.bound++;
    if (toId !== ref.toId || toFile !== ref.toFile) updates.push([toId, toFile ?? null, ref.id]);
  }

  // Refs that lost their binding go back to the family-wide name guess.
  if (needFallback.length > 0) {
    const byFamily = new Map<string, RefRow[]>();
    for (const ref of needFallback) {
      const lang = detectLang(ref.file);
      const fam = lang ? languageFamily(lang) : 'other';
      let list = byFamily.get(fam);
      if (!list) {
        list = [];
        byFamily.set(fam, list);
      }
      list.push(ref);
    }
    for (const [fam, famRefs] of byFamily) {
      const minByName = new Map<string, number>();
      for (const [name, id] of chunkedRows(
        store,
        [...new Set(famRefs.map((ref) => ref.toName))],
        (ph) => `SELECT sym.name, MIN(sym.id) FROM symbols sym
               JOIN lang_family lf ON lf.lang = sym.lang
              WHERE lf.family = '${fam}' AND sym.name IN (${ph})
              GROUP BY sym.name`,
      ) as Array<[string, number]>) {
        minByName.set(name, id);
      }
      for (const ref of famRefs) {
        updates.push([minByName.get(ref.toName) ?? null, null, ref.id]);
      }
    }
  }

  if (updates.length > 0) {
    store.write(() => {
      const update = store.stmt('UPDATE refs SET to_id = ?, to_file = ? WHERE id = ?');
      for (const [toId, toFile, id] of updates) {
        update.run(toId as never, toFile as never, id as never);
      }
    });
  }
  result.updated = updates.length;
  return result;
}

/** The IndexStore surface the per-run driver needs (structural: no cycle). */
export interface RefBindingHost {
  getMetadata(key: string): string | undefined;
  setMetadata(key: string, value: string): void;
  /** Distinct [owner file, to_name] of every ref whose `to_file` is a target. */
  getRefNamesTargeting(targets: readonly string[]): Array<[string, string]>;
  bindRefsByImports(scope: RefBindingScope | 'all'): RefBindingResult;
}

/**
 * What one run must rebind, captured BEFORE the relation pass rewrites
 * import targets: a ref bound into a rewritten or deleted file is found by
 * its `to_file`, which the relation pass may clear.
 */
export interface RefBindingPlan {
  all: boolean;
  files: Set<string>;
  names: Map<string, Set<string>>;
  structureBefore: string | undefined;
}

function addNames(names: Map<string, Set<string>>, rows: Array<[string, string]>): void {
  for (const [file, name] of rows) {
    let set = names.get(file);
    if (!set) {
      set = new Set();
      names.set(file, set);
    }
    set.add(name);
  }
}

export function planRefBinding(
  host: RefBindingHost,
  opts: {
    changes: { rewritten: ReadonlySet<string>; deleted: ReadonlySet<string> };
    /** Every ref was (re)resolved by name this run. */
    full: boolean;
    structureKey: string;
    moduleVersionCurrent: boolean;
  },
): RefBindingPlan {
  const structureBefore = host.getMetadata(opts.structureKey);
  const all =
    opts.full ||
    !opts.moduleVersionCurrent ||
    host.getMetadata(REF_BINDING_VERSION_KEY) !== REF_BINDING_VERSION;
  const files = new Set<string>();
  const names = new Map<string, Set<string>>();
  if (!all) {
    const { rewritten, deleted } = opts.changes;
    for (const file of rewritten) files.add(file);
    // Refs into these files: invalidation NULLed their to_id and the name
    // guess that replaced it knows nothing of imports; an import of a name
    // the changed file may now (not) export decides every same-named ref of
    // its file.
    addNames(names, host.getRefNamesTargeting([...rewritten, ...deleted]));
  }
  return { all, files, names, structureBefore };
}

/**
 * Run the binding the plan calls for, after the relation pass. Returns
 * whether any ref changed. Failure is recorded in `errors` and voids the
 * version key, so the next run rebinds everything.
 */
export function runRefBinding(
  host: RefBindingHost,
  plan: RefBindingPlan,
  opts: {
    added: ReadonlySet<string>;
    structureKey: string;
    errors: string[];
    signal?: AbortSignal | undefined;
  },
): boolean {
  if (opts.signal?.aborted) return false;
  try {
    const all = plan.all || host.getMetadata(opts.structureKey) !== plan.structureBefore;
    // Imports the relation pass just resolved into new files.
    if (!all && opts.added.size > 0) {
      addNames(plan.names, host.getRefNamesTargeting([...opts.added]));
    }
    if (!all && plan.files.size === 0 && plan.names.size === 0) return false;
    const result = host.bindRefsByImports(all ? 'all' : { files: plan.files, names: plan.names });
    host.setMetadata(REF_BINDING_VERSION_KEY, REF_BINDING_VERSION);
    return result.updated > 0;
  } catch (err) {
    try {
      host.setMetadata(REF_BINDING_VERSION_KEY, '');
    } catch {
      /* the original failure is what gets reported */
    }
    opts.errors.push(`ref binding: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
