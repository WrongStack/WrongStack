import * as path from 'node:path';
import {
  DEFAULT_WALK_IGNORE_DIRS,
  type ProjectWatchSubscription,
  watchProjectTree,
} from '@wrongstack/core/utils';
import { buildPendingEvents, flushJournalInputs } from './file-observer-journal.js';
import {
  fingerprint,
  isExcluded,
  normalizeExcludedPaths,
  normalizeRelative,
  sameFingerprint,
  scanProject,
  unionKeys,
} from './file-observer-scan.js';
import type {
  ChronicleFileObserver,
  ChronicleFileObserverOptions,
  ChronicleToolMutationHint,
  FileChange,
  RecentToolMutation,
} from './file-observer-types.js';

export type {
  ChronicleFileObserver,
  ChronicleFileObserverOptions,
  ChronicleToolMutationHint,
} from './file-observer-types.js';

/**
 * Directories this observer must never descend into.
 *
 * `.claude` earns its place the same way `.wrongstack` did: it is the tool's own
 * workspace, not the user's project, so nothing inside it is an "external
 * mutation" worth an audit event. It matters far more than it looks — git
 * worktrees live under `.claude/worktrees`, and a worktree is a full copy of the
 * repository. Creating one made the watcher report every tracked file as
 * `file.external.created`, and removing it reported every file again as
 * `deleted`. Measured on this repo: 85,619 of 85,813 file events in a single
 * day came from `.claude/worktrees`, ~95 MB of a 106 MB journal — 90% of the
 * day's telemetry describing the tool watching itself.
 */
const DEFAULT_EXCLUDED = [...DEFAULT_WALK_IGNORE_DIRS, '.wrongstack', '.claude', '.temp_files'];
// Platforms that omit the filename (common on Windows recursive watch) can
// emit null-filename events in bursts. Each one used to trigger a full
// project walk — bound rescans to this floor; a queued rescan is deferred,
// never dropped, so no external mutation is lost.
const DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS = 30_000;
/** Max entries in recentToolMutations before oldest are evicted. */
const MAX_RECENT_TOOL_MUTATIONS = 500;

/** Observe editor/user/external process mutations that bypass WrongStack tools. */
export async function startChronicleFileObserver(
  options: ChronicleFileObserverOptions,
): Promise<ChronicleFileObserver> {
  const root = path.resolve(options.projectRoot);
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED);
  const excludedPaths = normalizeExcludedPaths(root, options.excludedPaths ?? []);
  const debounceMs = options.debounceMs ?? 120;
  const maxHashBytes = options.maxHashBytes ?? 8 * 1024 * 1024;
  const known = (await scanProject(root, excluded, excludedPaths, maxHashBytes, options.onError))
    .files;
  const recentToolMutations = new Map<string, RecentToolMutation>();
  const noteToolMutation = (hint: ChronicleToolMutationHint): void => {
    const absolute = path.isAbsolute(hint.path)
      ? path.normalize(hint.path)
      : path.resolve(root, hint.path);
    const relative = normalizeRelative(path.relative(root, absolute));
    if (relative.startsWith('../') || isExcluded(relative, excluded, excludedPaths)) return;
    // Map.set on an existing key refreshes the value but keeps its ORIGINAL
    // insertion position, so re-noting a hot path left it at the FRONT of the
    // cap sweep — the newest hint was the eviction victim and its change
    // degraded to `file.external.*` (the sweep's own comment promises
    // oldest-first). Delete-then-set re-inserts at the back, making
    // insertion order genuinely oldest-first.
    recentToolMutations.delete(relative);
    recentToolMutations.set(relative, {
      at: hint.at ?? Date.now(),
      toolUseId: hint.toolUseId,
      toolName: hint.toolName,
      agentId: hint.agentId,
      sessionId: hint.sessionId,
    });
    // Evict oldest entries past the cap to prevent unbounded growth when
    // tool mutations accumulate faster than reconciliation drains them.
    if (recentToolMutations.size > MAX_RECENT_TOOL_MUTATIONS) {
      const overflow = recentToolMutations.size - MAX_RECENT_TOOL_MUTATIONS;
      const keys = [...recentToolMutations.keys()];
      for (let i = 0; i < overflow && i < keys.length; i++) {
        recentToolMutations.delete(keys[i]!);
      }
    }
  };
  const offToolProgress = options.events?.on('tool.progress', (event) => {
    if (event.event.type !== 'file_changed' || !event.event.path) return;
    noteToolMutation({
      path: event.event.path,
      toolUseId: event.id,
      toolName: event.name,
      agentId: event.agentId,
      sessionId: event.sessionId,
    });
  });
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let flushTail: Promise<void> | null = null;
  // Failure from the most recent reconcile drain, if any. close() clears
  // this when it begins its final drain and rethrows it after the drain
  // settles, so a failed shutdown flush is surfaced to the caller instead
  // of silently dropped (both production close sites catch: the CLI wiring
  // ignores the rejection, the project-server records it in
  // watcherLastError).
  let drainFailure: unknown;
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
    if (!relative || isExcluded(relative, excluded, excludedPaths)) return;
    pending.add(relative);
    bumpDebounce();
  };

  const reconcile = async (changedPaths: string[]): Promise<void> => {
    const wantsFullScan = changedPaths.includes('*');
    if (wantsFullScan) lastFullScanAt = Date.now();
    const fullScan = wantsFullScan
      ? await scanProject(root, excluded, excludedPaths, maxHashBytes, options.onError, known)
      : undefined;
    // Re-apply the exclusion boundary at reconciliation time. OS watchers can
    // report paths using a different recursive-root shape than the scheduling
    // callback (notably on Windows), and pending paths may outlive a directory
    // rename. Excluded tool workspaces must never become Chronicle events even
    // if an upstream watcher notification slips through the first filter.
    const candidates = (fullScan ? unionKeys(known, fullScan.files) : changedPaths).filter(
      (relative) => !isExcluded(relative, excluded, excludedPaths),
    );
    const changes: FileChange[] = [];
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
    const pendingEvents = buildPendingEvents(options, changes, recentToolMutations);
    try {
      await flushJournalInputs(options, pendingEvents, (committed) => {
        // This commit unit is durable — advance the fingerprint state for
        // exactly its events. A later failure therefore leaves `known` at
        // the journal's actual frontier, and the retry re-derives only the
        // uncommitted remainder instead of re-emitting committed events.
        for (const event of committed) {
          for (const [relative, after] of event.state) {
            if (after) known.set(relative, after);
            else known.delete(relative);
          }
          // The tool hint is consumed only now that its event is durable.
          // The identity check never deletes a NEWER hint that arrived for
          // the same path while this batch was in flight.
          if (
            event.attributionKey &&
            recentToolMutations.get(event.attributionKey) === event.attribution
          ) {
            recentToolMutations.delete(event.attributionKey);
          }
          // Live bus event fires exactly once per event, at commit — a
          // failed flush never announced the change, so the recovery
          // re-derive is not a duplicate.
          event.emitActivity?.();
        }
      });
    } catch (error) {
      // Committed chunks have already applied their state; the throwing
      // chunk and everything after it have not, so `known` sits exactly at
      // the journal's frontier. The next reconcile re-derives only that
      // remainder; requeue a bounded full rescan so recovery does not wait
      // for another filesystem event to touch the same files, then surface
      // the failure. (If the observer is closing, the rescan is dropped —
      // see close().)
      for (const event of pendingEvents) {
        if (!event.attribution || !event.attributionKey) continue;
        const held = recentToolMutations.get(event.attributionKey);
        // Skip hints already released by a committed unit, and never
        // clobber a newer hint that arrived after this batch was built.
        if (held !== event.attribution) continue;
        // Replay: refresh the 2s match window so the recovery pass
        // re-attributes these changes as `file.tool.*` with their original
        // correlation instead of degrading them to `file.external.*`.
        recentToolMutations.set(event.attributionKey, { ...event.attribution, at: Date.now() });
      }
      requestFullRescan();
      throw error;
    }
  };

  const drainPending = (): Promise<void> => {
    if (flushTail) return flushTail;
    const drain = (async () => {
      while (pending.size > 0) {
        const paths = [...pending];
        pending.clear();
        try {
          await reconcile(paths);
        } catch (error) {
          drainFailure = error;
          options.onError?.(error);
        }
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
    noteToolMutation,
    /**
     * Shut down the observer. If the final drain (an in-flight drain plus
     * anything still pending at close time) fails, close() REJECTS with
     * that error — a failed shutdown flush is surfaced, not silently
     * dropped. The failure is still not retried after close returns:
     * `requestFullRescan()` no-ops once `closed` is set, and `known` is
     * in-memory state that dies here, so uncommitted changes are not
     * re-derived by a future boot (the startup scan builds fresh
     * fingerprints without diffing against this process's history). The
     * journal remains authoritative for everything that did commit. A
     * second close() call is a no-op and does not re-throw.
     */
    async close() {
      if (closed) return;
      closed = true;
      // Only failures from here on are this close's final drain; an older
      // failure has already been reported (and likely recovered).
      drainFailure = undefined;
      offToolProgress?.();
      watcher.close();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (fullRescanTimer) {
        clearTimeout(fullRescanTimer);
        fullRescanTimer = undefined;
        // The timer was queued work — most commonly the bounded recovery
        // rescan a failed reconcile scheduled. Cancelling it without
        // converting it to final-drain work silently dropped the retry:
        // pending was empty, so close() resolved while uncommitted audit
        // events were lost forever. Run it as this close's final drain.
        pending.add('*');
      }
      if (pending.size > 0) drainPending();
      await flushTail;
      recentToolMutations.clear();
      if (drainFailure !== undefined) throw drainFailure;
    },
  };
}
