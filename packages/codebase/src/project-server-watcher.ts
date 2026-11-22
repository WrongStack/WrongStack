import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULT_WALK_IGNORE_SET,
  type ProjectWatchSubscription,
  watchProjectTree,
} from '@wrongstack/core/utils';
import { isAtlasProjection } from './index-source-files.js';
import { isIndexablePath } from './languages.js';
import type { ClientState } from './project-server-types.js';

export const DEFAULT_EXTERNAL_DEBOUNCE_MS = 400;
export const DEFAULT_EXTERNAL_COALESCE_WINDOW_MS = 50;

export function isIgnoredRelativePath(relativePath: string): boolean {
  return relativePath.split(/[/\\]/u).some((segment) => DEFAULT_WALK_IGNORE_SET.has(segment));
}

/**
 * Whether a non-indexable `rename` path may be a directory whose files the
 * index holds: an existing directory, or a vanished path without an
 * extension (a deleted `.png` must not trigger an index write run).
 */
export async function isDirectoryWatchCandidate(absolute: string): Promise<boolean> {
  try {
    return (await fs.stat(absolute)).isDirectory();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return (code === 'ENOENT' || code === 'ENOTDIR') && path.extname(absolute) === '';
  }
}

export interface ProjectServerWatcherOptions {
  projectRoot: string;
  onFilesChanged: (files: string[]) => void;
}

export class ProjectServerWatcherManager {
  private externalWatcher: ProjectWatchSubscription | undefined;
  private externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
  private externalCoalesceWindowMs = DEFAULT_EXTERNAL_COALESCE_WINDOW_MS;
  private readonly externalDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly externalReadyFiles = new Set<string>();
  private externalReadyFlush: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ProjectServerWatcherOptions) {}

  get isWatching(): boolean {
    return this.externalWatcher !== undefined;
  }

  get pendingFileCount(): number {
    return this.externalDebounceTimers.size + this.externalReadyFiles.size;
  }

  private enqueueExternalFile(file: string): void {
    const previous = this.externalDebounceTimers.get(file);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.externalDebounceTimers.delete(file);
      this.externalReadyFiles.add(file);
      // Sliding coalescing window: each file that arrives resets the flush
      // timer so a staggered burst (formatter-on-save touching several files
      // over ~10-50ms) stays open until the gap between arrivals exceeds the
      // window. windowMs=0 falls back to immediate flush via setTimeout(fn, 0).
      if (this.externalReadyFlush) clearTimeout(this.externalReadyFlush);
      this.externalReadyFlush = setTimeout(() => {
        this.externalReadyFlush = undefined;
        const files = [...this.externalReadyFiles].sort();
        this.externalReadyFiles.clear();
        this.options.onFilesChanged(files);
      }, this.externalCoalesceWindowMs);
      this.externalReadyFlush.unref?.();
    }, this.externalDebounceMs);
    timer.unref?.();
    this.externalDebounceTimers.set(file, timer);
  }

  private ensureExternalWatcher(): void {
    if (this.externalWatcher) return;
    const projectRoot = this.options.projectRoot;
    this.externalWatcher = watchProjectTree(
      projectRoot,
      ({ eventType, filename }) => {
        if (!filename || isIgnoredRelativePath(filename)) return;
        const absolute = path.resolve(projectRoot, filename);
        const relative = path.relative(projectRoot, absolute);
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          // The atlas is derived FROM the index and never indexed; writing it
          // (`/codebase-map --write`) must not queue an index run.
          isAtlasProjection(relative.replace(/\\/g, '/'))
        ) {
          return;
        }
        if (isIndexablePath(absolute)) {
          this.enqueueExternalFile(absolute);
          return;
        }
        // A deleted or renamed DIRECTORY arrives as one event naming the
        // directory, which is never an indexable path. Dropping it left every
        // file under it in the index; the indexer expands the path instead.
        if (eventType !== 'rename') return;
        void isDirectoryWatchCandidate(absolute).then((candidate) => {
          if (candidate && this.externalWatcher) this.enqueueExternalFile(absolute);
        });
      },
      {
        onError: () => {
          // Watch errors are non-fatal; explicit edit/startup requests remain
          // available through the same server.
        },
      },
    );
  }

  stop(): void {
    try {
      this.externalWatcher?.close();
    } catch {
      /* already closed */
    }
    this.externalWatcher = undefined;
    for (const timer of this.externalDebounceTimers.values()) clearTimeout(timer);
    this.externalDebounceTimers.clear();
    if (this.externalReadyFlush) clearTimeout(this.externalReadyFlush);
    this.externalReadyFlush = undefined;
    this.externalReadyFiles.clear();
  }

  reconcile(clients: Iterable<ClientState>): void {
    const owners = [...clients].filter((client) => client.watchExternal);
    if (owners.length === 0) {
      this.externalDebounceMs = DEFAULT_EXTERNAL_DEBOUNCE_MS;
      this.externalCoalesceWindowMs = DEFAULT_EXTERNAL_COALESCE_WINDOW_MS;
      this.stop();
      return;
    }
    this.externalDebounceMs = Math.min(...owners.map((client) => client.debounceMs));
    this.externalCoalesceWindowMs = Math.min(...owners.map((client) => client.coalesceWindowMs));
    this.ensureExternalWatcher();
  }
}
