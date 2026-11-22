import * as path from 'node:path';
import { loadGitignoreMatcher } from './gitignore.js';
import {
  DEFAULT_IGNORE,
  DEFAULT_IGNORE_FILES,
  expandTargetedDirectories,
  findSourceFiles,
  isAtlasProjection,
  isWithinProject,
} from './index-source-files.js';

import { detectLang } from './languages.js';
export async function discoverIndexerFiles(inputs: {
  projectRoot: string;
  opts: IndexerOptions;
  store: import('./writer.js').IndexStore;
  signal: AbortSignal | undefined;
  ignore: string[];
  errors: string[];
  langs: string[] | undefined;
}) {
  const { projectRoot, opts, store, signal, ignore, errors, langs } = inputs;

  // Honor the project-root .gitignore (skips node_modules, build output, and
  // any project-specific ignored paths) on top of the always-on DEFAULT_IGNORE.
  const isGitIgnored = await loadGitignoreMatcher(projectRoot);

  let files: string[];
  /** Set of all files discovered on disk (before language filtering).
   *  Used for O(1) stale-file detection instead of stat-ing every
   *  previously-indexed file. Null when an explicit file list was given. */
  let discoveredFiles: Set<string> | null = null;
  let discoveryComplete = true;
  let cleanBlobs: Map<string, string> | undefined;
  let discoverySnapshotKey: string | undefined;
  let dirtyHashes: Map<string, string> | undefined;
  if (opts.files && opts.files.length > 0) {
    // Explicit file list (per-edit / watcher path): keep paths inside the
    // project only and apply both always-on and .gitignore exclusions.
    const targeted = await expandTargetedDirectories(
      store,
      projectRoot,
      opts.files.map((f) => path.resolve(projectRoot, f)),
      isGitIgnored,
      signal,
    );
    files = targeted.filter((f) => {
      if (!isWithinProject(projectRoot, f)) return false;
      const rel = path.relative(projectRoot, f).replace(/\\/g, '/');
      return (
        !rel.split('/').some((seg) => DEFAULT_IGNORE.includes(seg)) &&
        !DEFAULT_IGNORE_FILES.has(path.basename(f)) &&
        !isAtlasProjection(rel) &&
        !isGitIgnored(rel, false)
      );
    });
  } else {
    const discovery = await findSourceFiles(projectRoot, ignore, isGitIgnored, signal);
    files = discovery.files;
    errors.push(...discovery.errors);
    discoveryComplete = discovery.complete;
    discoveredFiles = new Set(files);
    cleanBlobs = discovery.cleanBlobs;
    discoverySnapshotKey = discovery.snapshotKey;
    dirtyHashes = discovery.dirtyHashes;
  }

  if (langs && langs.length > 0) {
    const langSet = new Set(langs);
    files = files.filter((f) => {
      const lang = detectLang(f);
      return lang ? langSet.has(lang) : false;
    });
  }
  return {
    files,
    discoveredFiles,
    discoveryComplete,
    cleanBlobs,
    discoverySnapshotKey,
    dirtyHashes,
  };
}

export interface IndexerOptions {
  projectRoot: string;
  files?: string[] | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  ignore?: string[] | undefined;
  /** Override the index directory (default: the global per-project dir). */
  indexDir?: string | undefined;
  /**
   * Signal that cancels indexing cooperatively. Polled at yield points
   * (file walk, per-file loop) so a hung filesystem won't lock up the
   * process. When the tool executor's timeout fires, this signal aborts
   * and `runIndexer` throws, releasing the mutex and resetting flags.
   */
  signal?: AbortSignal | undefined;
  /**
   * Per-file progress callback. Injected by the caller instead of imported
   * from the host's module state so the indexer can run inside a worker
   * thread (worker posts progress messages; inline host updates its state).
   */
  onProgress?: ((current: number, total: number) => void) | undefined;
}
