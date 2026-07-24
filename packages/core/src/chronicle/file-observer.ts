import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import { mapWithConcurrency } from '../storage/storage-concurrency.js';
import { type ProjectWatchSubscription, watchProjectTree } from '../utils/project-watch.js';
import { DEFAULT_WALK_IGNORE_DIRS } from '../utils/walk-ignore.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleJournal } from './journal.js';
import type { ChronicleEventInput } from './types.js';

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  hash?: string | undefined;
}

interface RecentToolMutation {
  at: number;
  toolUseId: string;
  toolName: string;
  agentId?: string | undefined;
}

export interface ChronicleFileObserverOptions {
  projectRoot: string;
  journal: ChronicleJournal;
  context: ChronicleContext | (() => ChronicleContext);
  events?: EventBus | undefined;
  debounceMs?: number | undefined;
  maxHashBytes?: number | undefined;
  excludedDirectories?: readonly string[] | undefined;
  /** Min gap between full-project rescans triggered by null-filename events. */
  minFullRescanIntervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

export interface ChronicleFileObserver {
  close(): Promise<void>;
  readonly watchedFiles: number;
}

const DEFAULT_EXCLUDED = [...DEFAULT_WALK_IGNORE_DIRS, '.wrongstack', '.temp_files'];
const SCAN_HASH_CONCURRENCY = 32;
// Platforms that omit the filename (common on Windows recursive watch) can
// emit null-filename events in bursts. Each one used to trigger a full
// project walk — bound rescans to this floor; a queued rescan is deferred,
// never dropped, so no external mutation is lost.
const DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS = 30_000;

/** Observe editor/user/external process mutations that bypass WrongStack tools. */
export async function startChronicleFileObserver(
  options: ChronicleFileObserverOptions,
): Promise<ChronicleFileObserver> {
  const root = path.resolve(options.projectRoot);
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED);
  const debounceMs = options.debounceMs ?? 120;
  const maxHashBytes = options.maxHashBytes ?? 8 * 1024 * 1024;
  const known = (await scanProject(root, excluded, maxHashBytes, options.onError)).files;
  const recentToolMutations = new Map<string, RecentToolMutation>();
  const offToolProgress = options.events?.on('tool.progress', (event) => {
    if (event.event.type !== 'file_changed' || !event.event.path) return;
    const absolute = path.isAbsolute(event.event.path)
      ? path.normalize(event.event.path)
      : path.resolve(root, event.event.path);
    const relative = normalizeRelative(path.relative(root, absolute));
    if (relative.startsWith('../') || isExcluded(relative, excluded)) return;
    recentToolMutations.set(relative, {
      at: Date.now(),
      toolUseId: event.id,
      toolName: event.name,
      agentId: event.agentId,
    });
  });
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let flushTail: Promise<void> | null = null;
  const minFullRescanIntervalMs =
    options.minFullRescanIntervalMs ?? DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS;
  // The startup scan just ran — the first watcher-triggered full rescan also
  // waits out the interval instead of immediately repeating that work.
  let lastFullScanAt = Date.now();
  let fullRescanTimer: ReturnType<typeof setTimeout> | undefined;

  const bumpDebounce = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      drainPending();
    }, debounceMs);
  };

  // Some platforms omit the filename. A bounded full rescan recovers the
  // facts instead of silently losing an external mutation — but rescans walk
  // (and stat) the whole tree, so they are rate-limited: within the interval
  // the request is queued for the earliest allowed time, not dropped.
  const requestFullRescan = (): void => {
    if (closed) return;
    const since = Date.now() - lastFullScanAt;
    if (since >= minFullRescanIntervalMs) {
      pending.add('*');
      bumpDebounce();
      return;
    }
    if (fullRescanTimer) return;
    fullRescanTimer = setTimeout(() => {
      fullRescanTimer = undefined;
      if (closed) return;
      pending.add('*');
      bumpDebounce();
    }, minFullRescanIntervalMs - since);
    if (typeof fullRescanTimer.unref === 'function') fullRescanTimer.unref();
  };

  const schedule = (filename: string | Buffer | null): void => {
    if (closed) return;
    if (filename === null) {
      requestFullRescan();
      return;
    }
    const relative = normalizeRelative(String(filename));
    if (!relative || isExcluded(relative, excluded)) return;
    pending.add(relative);
    bumpDebounce();
  };

  const reconcile = async (changedPaths: string[]): Promise<void> => {
    const wantsFullScan = changedPaths.includes('*');
    if (wantsFullScan) lastFullScanAt = Date.now();
    const fullScan = wantsFullScan
      ? await scanProject(root, excluded, maxHashBytes, options.onError, known)
      : undefined;
    const candidates = fullScan ? unionKeys(known, fullScan.files) : changedPaths;
    const changes: Array<{
      relative: string;
      before?: FileFingerprint | undefined;
      after?: FileFingerprint | undefined;
    }> = [];
    for (const relative of candidates) {
      const before = known.get(relative);
      // A successful full scan already paid the stat/read/hash cost. Reuse
      // those fingerprints instead of reading every file a second time.
      // When the scan is incomplete (a directory read or individual hash
      // threw), reuse whatever was hashed successfully and only re-probe
      // the files the scan did not reach — never treat a scan gap as a
      // deletion.
      const cached = fullScan?.files.get(relative);
      const after =
        cached ??
        (fullScan?.complete
          ? undefined
          : await fingerprint(path.join(root, relative), maxHashBytes));
      if (sameFingerprint(before, after)) continue;
      changes.push({ relative, before, after });
    }

    // Atomic saves and renames commonly arrive as delete+create. Matching the
    // last-known content hash preserves resource lineage when the OS provides
    // only generic "rename" notifications.
    const deleted = changes.filter((change) => change.before && !change.after);
    const created = changes.filter((change) => !change.before && change.after);
    const consumed = new Set<string>();
    const journalWrites: Promise<void>[] = [];
    for (const from of deleted) {
      const match = created.find(
        (to) =>
          !consumed.has(to.relative) &&
          from.before?.hash !== undefined &&
          from.before.hash === to.after?.hash,
      );
      if (!match) continue;
      consumed.add(from.relative);
      consumed.add(match.relative);
      known.delete(from.relative);
      known.set(match.relative, match.after!);
      journalWrites.push(
        recordMutation(
          options,
          'file.external.renamed',
          match.relative,
          match.after,
          {
            operation: 'rename',
            previousPath: from.relative,
            previousResourceId: resourceId(from.relative),
            actor: 'external',
          },
          mutationAttribution(match.relative, recentToolMutations),
        ),
      );
    }

    for (const change of changes) {
      if (consumed.has(change.relative)) continue;
      if (!change.after) {
        known.delete(change.relative);
        journalWrites.push(
          recordMutation(
            options,
            'file.external.deleted',
            change.relative,
            change.before,
            {
              operation: 'delete',
              actor: 'external',
              previousHash: change.before?.hash,
              previousSize: change.before?.size,
            },
            mutationAttribution(change.relative, recentToolMutations),
          ),
        );
      } else if (!change.before) {
        known.set(change.relative, change.after);
        journalWrites.push(
          recordMutation(
            options,
            'file.external.created',
            change.relative,
            change.after,
            {
              operation: 'write',
              actor: 'external',
            },
            mutationAttribution(change.relative, recentToolMutations),
          ),
        );
      } else {
        known.set(change.relative, change.after);
        journalWrites.push(
          recordMutation(
            options,
            'file.external.modified',
            change.relative,
            change.after,
            {
              operation: 'edit',
              actor: 'external',
              previousHash: change.before.hash,
              previousSize: change.before.size,
            },
            mutationAttribution(change.relative, recentToolMutations),
          ),
        );
      }
    }
    await Promise.all(journalWrites);
  };

  const drainPending = (): Promise<void> => {
    if (flushTail) return flushTail;
    const drain = (async () => {
      while (pending.size > 0) {
        const paths = [...pending];
        pending.clear();
        await reconcile(paths).catch((error) => options.onError?.(error));
      }
    })().finally(() => {
      if (flushTail === drain) flushTail = null;
      if (!closed && pending.size > 0) drainPending();
    });
    flushTail = drain;
    return drain;
  };

  let watcher: ProjectWatchSubscription;
  try {
    watcher = watchProjectTree(root, (event) => schedule(event.filename), {
      onError: (error) => options.onError?.(error),
    });
  } catch (error) {
    options.onError?.(error);
    throw error;
  }

  return {
    get watchedFiles() {
      return known.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      offToolProgress?.();
      watcher.close();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (fullRescanTimer) {
        clearTimeout(fullRescanTimer);
        fullRescanTimer = undefined;
      }
      if (pending.size > 0) drainPending();
      await flushTail;
    },
  };
}

async function recordMutation(
  options: ChronicleFileObserverOptions,
  eventType: string,
  relativePath: string,
  state: FileFingerprint | undefined,
  attributes: Record<string, unknown>,
  attribution?: RecentToolMutation | undefined,
): Promise<void> {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const operation = attributes['operation'] as 'write' | 'edit' | 'delete' | 'rename';
  options.events?.emit('file.activity', {
    filePath: path.join(options.projectRoot, relativePath),
    operation,
    phase: 'changed',
    source: attribution ? 'tool' : 'external',
    at: Date.now(),
    sessionId: context.scope.sessionId,
    traceId: context.correlation.traceId,
    agentId: attribution?.agentId ?? context.scope.agentId,
    ...(attribution ? { toolUseId: attribution.toolUseId, toolName: attribution.toolName } : {}),
  });
  const input: ChronicleEventInput = {
    eventType: attribution ? eventType.replace('.external.', '.tool.') : eventType,
    scope: context.scope,
    correlation: {
      ...context.correlation,
      ...(attribution ? { toolCallId: attribution.toolUseId } : {}),
    },
    outcome: 'success',
    resource: {
      kind: 'file',
      id: resourceId(relativePath),
      path: normalizeRelative(relativePath),
      ...(state?.hash ? { contentHashAfter: state.hash } : {}),
    },
    attributes: {
      ...attributes,
      actor: attribution ? 'agent' : attributes['actor'],
      source: attribution ? 'tool' : 'external',
      toolName: attribution?.toolName,
      size: state?.size,
      mtimeMs: state?.mtimeMs,
      observedBy: 'fs.watch',
    },
  };
  await options.journal.append(input);
}

function mutationAttribution(
  relativePath: string,
  recent: Map<string, RecentToolMutation>,
): RecentToolMutation | undefined {
  const value = recent.get(relativePath);
  if (!value) return undefined;
  recent.delete(relativePath);
  return Date.now() - value.at <= 2_000 ? value : undefined;
}

async function scanProject(
  root: string,
  excluded: ReadonlySet<string>,
  maxHashBytes: number,
  onError?: ((error: unknown) => void) | undefined,
  previous?: ReadonlyMap<string, FileFingerprint> | undefined,
): Promise<{ files: Map<string, FileFingerprint>; complete: boolean }> {
  const result = new Map<string, FileFingerprint>();
  const dirs = [''];
  let complete = true;
  while (dirs.length > 0) {
    const relativeDir = dirs.pop()!;
    try {
      const entries = await fsp.readdir(path.join(root, relativeDir), { withFileTypes: true });
      const filePaths: string[] = [];
      for (const entry of entries) {
        const relative = normalizeRelative(path.join(relativeDir, entry.name));
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) dirs.push(relative);
        } else if (entry.isFile()) {
          filePaths.push(relative);
        }
      }
      const fingerprints = await mapWithConcurrency(
        filePaths,
        SCAN_HASH_CONCURRENCY,
        async (relative): Promise<[string, FileFingerprint] | null> => {
          try {
            const value = await fingerprint(
              path.join(root, relative),
              maxHashBytes,
              previous?.get(relative),
            );
            return value ? [relative, value] : null;
          } catch (error) {
            complete = false;
            onError?.(error);
            return null;
          }
        },
      );
      for (const entry of fingerprints) {
        if (entry) result.set(entry[0], entry[1]);
      }
    } catch (error) {
      complete = false;
      onError?.(error);
    }
  }
  return { files: result, complete };
}

async function fingerprint(
  filePath: string,
  maxHashBytes: number,
  previous?: FileFingerprint | undefined,
): Promise<FileFingerprint | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return undefined;
    const base: FileFingerprint = { size: stat.size, mtimeMs: stat.mtimeMs };
    // Unchanged size+mtime → reuse the known content hash instead of
    // re-reading the file. Full rescans over a quiet tree become stat-only.
    if (previous?.hash !== undefined && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      base.hash = previous.hash;
      return base;
    }
    if (stat.size <= maxHashBytes) {
      base.hash = createHash('sha256')
        .update(await fsp.readFile(filePath))
        .digest('hex');
    }
    return base;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function isExcluded(relative: string, excluded: ReadonlySet<string>): boolean {
  return normalizeRelative(relative)
    .split('/')
    .some((segment) => excluded.has(segment));
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function resourceId(relativePath: string): string {
  return `file_${createHash('sha256').update(normalizeRelative(relativePath)).digest('hex').slice(0, 24)}`;
}

function unionKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])];
}
