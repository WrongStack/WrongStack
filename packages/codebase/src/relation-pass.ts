/**
 * Post-index pass: derive the project's ecosystem structure, label every file
 * with its Code Atlas package, and resolve import specifiers to target files.
 *
 * This runs after indexing rather than during it for two reasons. Resolution
 * needs the *complete* file set — a file cannot resolve an import to a module
 * that has not been discovered yet — and the evidence it depends on (`go.mod`,
 * `Cargo.toml`, `package.json`) lives on disk, not in the database, so doing it
 * here is what allows the graph readers to stay purely SQL and language-blind.
 *
 * The pass is proportional to what the run changed. It used to redo the whole
 * repository on every run — structure detection, a label write for every file
 * and a resolution of every import — which made a one-file watcher edit cost
 * ~450 ms and a full run over an unchanged checkout ~1.5 s of pure rework.
 * What can actually change an answer:
 *
 * | change                               | labels         | imports re-resolved              |
 * |--------------------------------------|----------------|----------------------------------|
 * | file content rewritten               | —              | that file's own imports          |
 * | file added                           | the new file   | + every import still unresolved  |
 * | file deleted                         | —              | + importers of the deleted file  |
 * | structure (roots) differ from stored | all            | all                              |
 * | namespace-resolved family touched    | —              | all                              |
 * | marker file (`__init__.py`, …) touched | all          | (as above)                       |
 *
 * Structure detection itself is cached per store and invalidated through a
 * `relation_epoch` metadata key, so another process that changes the file set
 * (a CLI run next to the daemon) cannot leave this one resolving against a
 * stale layout. A full-project run always re-detects: markers that are not
 * indexed (`go.mod`, `*.csproj`) reach no watcher, and the full run is where
 * their edits have always been picked up.
 *
 * Failures are recorded and swallowed: a repo with an unreadable manifest still
 * gets a usable index, just with coarser grouping. Returns whether any label or
 * edge may have changed.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { detectLang, languageFamily } from './languages.js';
import { ModuleResolver } from './module-resolver.js';
import { assignPackageLabels, detectModuleRoots, type ProjectStructure } from './module-roots.js';
import type { SymbolLang } from './schema.js';
import type { IndexStore } from './writer.js';

/**
 * Data-version marker for module resolution, in the spirit of
 * `relation_graph_version`: bump it when resolver or labelling logic changes,
 * and every index re-labels and re-resolves once. Full runs no longer redo
 * that work unconditionally, so without this a resolver fix would only reach
 * files edited after it shipped.
 */
export const MODULE_RESOLUTION_VERSION = '1';
export const MODULE_RESOLUTION_VERSION_KEY = 'module_resolution_version';
/** Fingerprint of the detected module roots the stored labels were built from. */
export const RELATION_STRUCTURE_KEY = 'relation_structure';
/** Changes whenever the file set, structure or namespaces change (any process). */
export const RELATION_EPOCH_KEY = 'relation_epoch';

/** What one index run changed, as the relation pass needs to know it. */
export interface RelationChanges {
  /** Files whose rows this run rewrote — re-parsed or emptied. */
  rewritten: ReadonlySet<string>;
  /** Files that had no row before this run and have one now (⊆ rewritten). */
  added: ReadonlySet<string>;
  /** Files whose rows this run removed. */
  deleted: ReadonlySet<string>;
}

/**
 * Filenames whose presence or content changes labelling. `package.json`,
 * `Cargo.toml`, `go.mod`, … define module roots; `__init__.py` defines the
 * dotted Python package chain.
 */
const STRUCTURE_MARKERS: ReadonlySet<string> = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '__init__.py',
]);

/** Families whose imports resolve against indexed namespace declarations. */
const NAMESPACE_FAMILIES: ReadonlySet<string> = new Set(['dotnet', 'php', 'elixir', 'haskell']);

export function isStructureMarker(file: string): boolean {
  const base = path.basename(file);
  return STRUCTURE_MARKERS.has(base) || base.toLowerCase().endsWith('.csproj');
}

function inNamespaceFamily(file: string): boolean {
  const lang = detectLang(file);
  return lang !== null && NAMESPACE_FAMILIES.has(languageFamily(lang));
}

function structureKey(structure: ProjectStructure): string {
  return createHash('sha256').update(JSON.stringify(structure.roots)).digest('hex');
}

interface RelationContext {
  epoch: string;
  structureKey: string;
  /** Size of the file set the resolver indexed. */
  fileCount: number;
  resolver: ModuleResolver;
}

const contexts = new WeakMap<IndexStore, RelationContext>();

/** Drop the cached structure for `store` (tests, and after a failed pass). */
export function forgetRelationContext(store: IndexStore): void {
  contexts.delete(store);
}

type ImportEntry = { fromFile: string; lang: string; module: string };

export async function resolveProjectRelations(
  store: IndexStore,
  projectRoot: string,
  opts: {
    changes: RelationChanges;
    /** Re-label and re-resolve everything (forced run, contract bump). */
    full: boolean;
    /** A whole-project discovery run, as opposed to a targeted file list. */
    projectScan: boolean;
    errors: string[];
    signal?: AbortSignal | undefined;
  },
): Promise<boolean> {
  // An aborted run skips the pass rather than throwing: the indexer's contract
  // is to return partial results with errors recorded, and turning a graceful
  // return into a rejection here would change that for every caller.
  if (opts.signal?.aborted) return false;
  const { changes } = opts;
  let wrote = false;
  try {
    const full =
      opts.full || store.getMetadata(MODULE_RESOLUTION_VERSION_KEY) !== MODULE_RESOLUTION_VERSION;
    const touched = [...changes.rewritten, ...changes.deleted];
    if (!full && !opts.projectScan && touched.length === 0) return false;

    const markerTouched = touched.some(isStructureMarker);
    const namespaceTouched = touched.some(inNamespaceFamily);
    const fileSetChanged = changes.added.size > 0 || changes.deleted.size > 0;

    let context = contexts.get(store);
    const storedEpoch = store.getMetadata(RELATION_EPOCH_KEY) ?? '';
    if (context && context.epoch !== storedEpoch) context = undefined;

    let files: string[] | undefined;
    let structure: ProjectStructure | undefined;
    let key = context?.structureKey;
    let structureChanged = false;
    const needsStructure =
      full || opts.projectScan || !context || fileSetChanged || markerTouched || namespaceTouched;
    if (needsStructure) {
      files = store.getAllFileMetas().map((meta) => meta.file);
      if (files.length === 0) {
        forgetRelationContext(store);
        return false;
      }
      structure = await detectModuleRoots(projectRoot, files);
      if (opts.signal?.aborted) return false;
      key = structureKey(structure);
      structureChanged = key !== store.getMetadata(RELATION_STRUCTURE_KEY);
      // A file set that moved under us without an epoch bump (an older build
      // writing the same database) still invalidates the cached resolver.
      if (context && context.fileCount !== files.length) context = undefined;

      // Labels: all when the layout moved (or on demand), else only new files.
      // The write is a diff against the stored labels either way — rewriting
      // ten thousand identical rows was most of a full pass's write cost.
      const relabelAll = full || structureChanged || markerTouched;
      if (relabelAll || changes.added.size > 0) {
        const labels = assignPackageLabels(
          structure,
          files,
          relabelAll ? undefined : changes.added,
        );
        const stored = store.getFilePackages();
        const diff = new Map<string, string>();
        for (const [file, label] of labels) {
          if (stored.get(file) !== label) diff.set(file, label);
        }
        store.setFilePackages(diff);
        if (diff.size > 0) wrote = true;
      }
      if (structureChanged) store.setMetadata(RELATION_STRUCTURE_KEY, key);
    }

    const shapeChanged = full || structureChanged || fileSetChanged || namespaceTouched;
    let epoch = storedEpoch;
    if (shapeChanged || !storedEpoch) {
      epoch = randomUUID();
      store.setMetadata(RELATION_EPOCH_KEY, epoch);
    }
    if (shapeChanged) context = undefined;
    else if (context) context.epoch = epoch;

    const resolveAll = full || structureChanged || namespaceTouched;
    let pending: ImportEntry[];
    if (resolveAll) {
      pending = store.getUnresolvedImports();
    } else {
      const scope = new Set<string>(changes.rewritten);
      // A deleted target leaves its importers pointing at nothing.
      for (const importer of store.getImportersOfFiles([...changes.deleted])) scope.add(importer);
      // A whole-project run also sweeps any dangling edge an older build left.
      if (opts.projectScan && touched.length > 0) {
        for (const importer of store.getFilesWithDanglingImports()) scope.add(importer);
      }
      pending = scope.size > 0 ? store.getUnresolvedImports([...scope]) : [];
      // A new file can satisfy an import written long before it existed.
      if (changes.added.size > 0) {
        for (const entry of store.getImportsWithoutTarget()) pending.push(entry);
      }
    }
    if (pending.length === 0) {
      store.setMetadata(MODULE_RESOLUTION_VERSION_KEY, MODULE_RESOLUTION_VERSION);
      return wrote;
    }

    // The resolver is only built when something needs resolving — a cold
    // daemon's first no-op run should not pay for indexing every path.
    if (!context) {
      files ??= store.getAllFileMetas().map((meta) => meta.file);
      structure ??= await detectModuleRoots(projectRoot, files);
      if (opts.signal?.aborted) return wrote;
      key ??= structureKey(structure);
      context = {
        epoch,
        structureKey: key,
        fileCount: files.length,
        resolver: new ModuleResolver(structure, files, store.getNamespaceDeclarations()),
      };
      contexts.set(store, context);
    }
    const { resolver } = context;

    const resolutions: Array<ImportEntry & { toFile: string | null }> = [];
    for (const entry of pending) {
      const toFile = resolver.resolve(entry.fromFile, entry.lang as SymbolLang, entry.module);
      // Unresolved entries are written as null so a stale `to_file` is cleared.
      // Self-imports (a barrel re-exporting its own directory) are not edges.
      resolutions.push({ ...entry, toFile: toFile && toFile !== entry.fromFile ? toFile : null });
    }
    if (opts.signal?.aborted) return wrote;
    if (store.applyImportResolutions(resolutions) > 0) wrote = true;
    store.setMetadata(MODULE_RESOLUTION_VERSION_KEY, MODULE_RESOLUTION_VERSION);
    return wrote;
  } catch (err) {
    // The cached structure may describe work this failure left half done, and
    // the next run must not trust the stored labels/edges: void the version
    // so it redoes the whole pass (full runs used to heal this implicitly).
    forgetRelationContext(store);
    try {
      store.setMetadata(MODULE_RESOLUTION_VERSION_KEY, '');
    } catch {
      /* the original failure is what gets reported */
    }
    opts.errors.push(`relation resolution: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
