import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import { mapWithConcurrency } from '../storage/storage-concurrency.js';
import { type ProjectWatchSubscription, watchProjectTree } from '../utils/project-watch.js';
import { DEFAULT_WALK_IGNORE_DIRS } from '../utils/walk-ignore.js';
import type { ChronicleContext } from './context.js';
import { CHRONICLE_MAX_APPEND_BATCH } from './project-server-protocol.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  hash?: string | undefined;
}

/** One reconciled path with its fingerprints on either side of the change. */
interface FileChange {
  relative: string;
  before?: FileFingerprint | undefined;
  after?: FileFingerprint | undefined;
}

/**
 * One journal event paired with the fingerprint-state writes that become
 * valid only once that event's commit unit — an `appendBatch` chunk, or a
 * single `append` on the legacy fallback path — has actually landed.
 *
 * Pairing state with its event (rather than keeping a flat side map) is what
 * makes partial-commit recovery exact: when chunk 3 of 5 throws, chunks 1–2
 * have already applied their state, so the retry re-derives only the
 * uncommitted remainder instead of re-emitting committed events.
 */
interface PendingEvent {
  input: ChronicleEventInput;
  /** `[relative, after]` pairs; `undefined` after marks a delete. */
  state: Array<[relative: string, after: FileFingerprint | undefined]>;
  /**
   * Deferred live `file.activity` emission. Built at observation time but
   * invoked at most once, and only when this event's commit unit lands —
   * emitting at build time meant a failed flush had already announced the
   * change and the recovery re-derive announced it a second time.
   */
  emitActivity?: (() => void) | undefined;
  /**
   * Tool-mutation hint claimed by this event, and the `recentToolMutations`
   * key it was claimed under. Released at commit; restored with a fresh
   * `at` on flush failure so the recovery pass re-attributes the event as
   * `file.tool.*` with its original correlation instead of degrading it to
   * `file.external.*`.
   */
  attribution?: RecentToolMutation | undefined;
  attributionKey?: string | undefined;
}

interface RecentToolMutation {
  at: number;
  toolUseId: string;
  toolName: string;
  agentId?: string | undefined;
  sessionId?: string | undefined;
}

export interface ChronicleToolMutationHint {
  path: string;
  toolUseId: string;
  toolName: string;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  at?: number | undefined;
}

export interface ChronicleFileObserverOptions {
  projectRoot: string;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  events?: EventBus | undefined;
  debounceMs?: number | undefined;
  maxHashBytes?: number | undefined;
  excludedDirectories?: readonly string[] | undefined;
  /** Absolute or project-relative path prefixes that must never be observed. */
  excludedPaths?: readonly string[] | undefined;
  /** Min gap between full-project rescans triggered by null-filename events. */
  minFullRescanIntervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

export interface ChronicleFileObserver {
  close(): Promise<void>;
  readonly watchedFiles: number;
  noteToolMutation(hint: ChronicleToolMutationHint): void;
}

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
const SCAN_HASH_CONCURRENCY = 32;
// Platforms that omit the filename (common on Windows recursive watch) can
// emit null-filename events in bursts. Each one used to trigger a full
// project walk — bound rescans to this floor; a queued rescan is deferred,
// never dropped, so no external mutation is lost.
const DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS = 30_000;
/** Max entries in recentToolMutations before oldest are evicted. */
const MAX_RECENT_TOOL_MUTATIONS = 500;

/**
 * Events per `appendBatch` call when flushing a reconcile pass. Matches the
 * project-server's own accept limit so a batch built here is never rejected
 * as oversized by the transport on the other side of the socket.
 */
const JOURNAL_FLUSH_CHUNK = CHRONICLE_MAX_APPEND_BATCH;

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

    // Atomic saves and renames commonly arrive as delete+create. Matching the
    // last-known content hash preserves resource lineage when the OS provides
    // only generic "rename" notifications.
    const deleted = changes.filter((change) => change.before && !change.after);
    const created = changes.filter((change) => !change.before && change.after);
    const consumed = new Set<string>();
    // Journal events, each paired with the fingerprint-state writes that
    // may be applied only after that event's commit unit lands. Applying
    // state while inputs are still being built meant a flush that threw (a
    // chunk failure, a closed project-server socket) left `known` already
    // advanced past changes whose events were never written — and since
    // the pending set was drained, no later reconcile re-derived them:
    // audit events were permanently lost. Commit-unit pairing instead
    // advances state exactly as far as the journal actually committed, so
    // a retry after a partial flush re-derives only the remainder.
    const pendingEvents: PendingEvent[] = [];
    /**
     * Build one pending event: PEEK at (do not consume) the tool-attribution
     * hint for the changed path, build the journal input plus its deferred
     * live-activity emitter, and record the hint/key pair so the commit
     * callback can release it and the failure path can restore it.
     */
    const pushPending = (
      eventType: string,
      relativePath: string,
      state: FileFingerprint | undefined,
      attributes: Record<string, unknown>,
      stateWrites: Array<[relative: string, after: FileFingerprint | undefined]>,
    ): void => {
      const attribution = peekAttribution(relativePath, recentToolMutations);
      const { input, emitActivity } = buildMutation(
        options,
        eventType,
        relativePath,
        state,
        attributes,
        attribution,
      );
      pendingEvents.push({
        input,
        state: stateWrites,
        emitActivity,
        attribution,
        attributionKey: attribution ? relativePath : undefined,
      });
    };
    // Index the creates by content hash rather than rescanning the array for
    // every delete. A branch switch or a build drop can put thousands of
    // entries in BOTH lists, and the linear scan made this pass
    // O(deletes x creates). Buckets keep insertion order behind a cursor, so
    // each delete still claims the FIRST unclaimed create with a matching
    // hash — identical pairing to the `created.find(...)` it replaces.
    const createdByHash = new Map<string, { entries: FileChange[]; cursor: number }>();
    for (const to of created) {
      const hash = to.after?.hash;
      if (hash === undefined) continue;
      const bucket = createdByHash.get(hash);
      if (bucket) bucket.entries.push(to);
      else createdByHash.set(hash, { entries: [to], cursor: 0 });
    }
    const claimCreated = (hash: string): FileChange | undefined => {
      const bucket = createdByHash.get(hash);
      if (!bucket) return undefined;
      // The cursor never revisits an entry, so a create is claimed at most
      // once without consulting `consumed`.
      return bucket.cursor < bucket.entries.length ? bucket.entries[bucket.cursor++] : undefined;
    };
    for (const from of deleted) {
      const fromHash = from.before?.hash;
      if (fromHash === undefined) continue;
      const match = claimCreated(fromHash);
      if (!match) continue;
      consumed.add(from.relative);
      consumed.add(match.relative);
      pushPending(
        'file.external.renamed',
        match.relative,
        match.after,
        {
          operation: 'rename',
          previousPath: from.relative,
          previousResourceId: resourceId(from.relative),
          actor: 'external',
        },
        [
          [from.relative, undefined],
          [match.relative, match.after!],
        ],
      );
    }

    for (const change of changes) {
      if (consumed.has(change.relative)) continue;
      if (!change.after) {
        pushPending(
          'file.external.deleted',
          change.relative,
          change.before,
          {
            operation: 'delete',
            actor: 'external',
            previousHash: change.before?.hash,
            previousSize: change.before?.size,
          },
          [[change.relative, undefined]],
        );
      } else if (!change.before) {
        pushPending(
          'file.external.created',
          change.relative,
          change.after,
          {
            operation: 'write',
            actor: 'external',
          },
          [[change.relative, change.after]],
        );
      } else {
        pushPending(
          'file.external.modified',
          change.relative,
          change.after,
          {
            operation: 'edit',
            actor: 'external',
            previousHash: change.before.hash,
            previousSize: change.before.size,
          },
          [[change.relative, change.after]],
        );
      }
    }
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

/**
 * Build the Chronicle input for one reconciled change, plus the DEFERRED
 * live `file.activity` emitter that the caller fires at commit time.
 *
 * This used to `await journal.append(input)` itself, which meant one SQLite
 * transaction — and, at `synchronous = FULL`, one fsync — PER CHANGED FILE.
 * A `git checkout` touching 2000 files paid 2000 of them, serially: the
 * caller collected the promises and `Promise.all`-ed them, but node:sqlite is
 * a synchronous binding, so nothing overlapped. Building the input here and
 * committing the whole reconcile pass through {@link flushJournalInputs}
 * collapses that to a handful of transactions.
 *
 * The bus event moved from here to the commit callback for the same reason
 * the fingerprint state did: emitting at build time announced changes whose
 * journal write then failed, and the recovery re-derive announced them a
 * second time — duplicate live events for one filesystem change.
 */
function buildMutation(
  options: ChronicleFileObserverOptions,
  eventType: string,
  relativePath: string,
  state: FileFingerprint | undefined,
  attributes: Record<string, unknown>,
  attribution?: RecentToolMutation | undefined,
): { input: ChronicleEventInput; emitActivity?: (() => void) | undefined } {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const operation = attributes['operation'] as 'write' | 'edit' | 'delete' | 'rename';
  const bus = options.events;
  // The live `file.activity` bus event is DEFERRED to commit time — see
  // PendingEvent.emitActivity. The payload is still built here so `at`
  // reflects when the change was observed, not when the journal landed.
  // `as const` preserves the literal unions the EventBus payload type
  // requires now that the object is extracted instead of inline.
  const activity = {
    filePath: path.join(options.projectRoot, relativePath),
    operation,
    phase: 'changed',
    source: attribution ? 'tool' : 'external',
    at: Date.now(),
    sessionId: context.scope.sessionId,
    traceId: context.correlation.traceId,
    agentId: attribution?.agentId ?? context.scope.agentId,
    ...(attribution ? { toolUseId: attribution.toolUseId, toolName: attribution.toolName } : {}),
  } as const;
  const emitActivity: (() => void) | undefined = bus
    ? () => {
        bus.emit('file.activity', activity);
      }
    : undefined;
  const input: ChronicleEventInput = {
    eventType: attribution ? eventType.replace('.external.', '.tool.') : eventType,
    scope: {
      ...context.scope,
      ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
      ...(attribution?.agentId ? { agentId: attribution.agentId } : {}),
    },
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
  return { input, emitActivity };
}

/**
 * Commit one reconcile pass's events, preferring the sink's batch entry point.
 *
 * Sinks predating `appendBatch` (and test doubles) fall back to starting every
 * `append` at once. That is deliberate, not laziness: the file-backed
 * `ChronicleJournal` coalesces whatever lands inside its 5ms batch window, so
 * awaiting the appends one at a time would drain the window between each and
 * turn one batch into N — the opposite of the point. Concurrent starts
 * reproduce exactly what this function replaced.
 *
 * The batch is chunked so a single enormous reconcile cannot build one
 * oversized frame for the project-server transport.
 *
 * `onCommitted` fires once per commit unit — after each `appendBatch` chunk
 * resolves, or after each individual `append` on the fallback path — with
 * exactly the events that just became durable. The caller applies those
 * events' fingerprint-state writes there, which is what keeps a mid-flush
 * failure from either losing unattempted events (state ahead of the journal)
 * or re-emitting committed ones (state behind the journal).
 */
async function flushJournalInputs(
  options: ChronicleFileObserverOptions,
  events: readonly PendingEvent[],
  onCommitted: (committed: readonly PendingEvent[]) => void,
): Promise<void> {
  if (events.length === 0) return;
  const batch = options.journal.appendBatch?.bind(options.journal);
  if (!batch) {
    // Wait for EVERY append to settle before surfacing any failure.
    // Promise.all's fail-fast hands the rejection to the caller while
    // sibling appends are still in flight; their commits then land after
    // the recovery rescan has already re-derived them — duplicate audit
    // events. allSettled lets every fulfilled append apply its state (via
    // onCommitted) first, so `known` ends exactly at the journal's
    // frontier no matter which appends failed.
    const settled = await Promise.allSettled(
      events.map(async (event) => {
        await options.journal.append(event.input);
        onCommitted([event]);
      }),
    );
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return;
  }
  for (let index = 0; index < events.length; index += JOURNAL_FLUSH_CHUNK) {
    const chunk = events.slice(index, index + JOURNAL_FLUSH_CHUNK);
    await batch(chunk.map((event) => event.input));
    onCommitted(chunk);
  }
}

/**
 * PEEK at the tool-mutation hint for a path without consuming it.
 *
 * Claim/release is tied to the journal commit, not the build: the hint is
 * released only when its event's commit unit lands (see the onCommitted
 * callback in reconcile) and restored with a fresh `at` when the flush
 * fails, so the recovery pass re-attributes the change as `file.tool.*`
 * with its original correlation. Popping at build time — the old behavior
 * — meant a failed flush permanently lost the attribution and the retry
 * degraded the event to `file.external.*`.
 *
 * Stale (>2s) hints are reported as no attribution but deliberately left
 * in the map: they age out via the size cap or are overwritten by the next
 * hint for the same path.
 */
function peekAttribution(
  relativePath: string,
  recent: Map<string, RecentToolMutation>,
): RecentToolMutation | undefined {
  const value = recent.get(relativePath);
  if (!value) return undefined;
  return Date.now() - value.at <= 2_000 ? value : undefined;
}

async function scanProject(
  root: string,
  excluded: ReadonlySet<string>,
  excludedPaths: ReadonlySet<string>,
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
        if (isExcluded(relative, excluded, excludedPaths)) continue;
        if (entry.isDirectory()) {
          dirs.push(relative);
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
    if (
      previous?.hash !== undefined &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs
    ) {
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

function isExcluded(
  relative: string,
  excluded: ReadonlySet<string>,
  excludedPaths: ReadonlySet<string>,
): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized.split('/').some((segment) => excluded.has(segment))) return true;
  for (const prefix of excludedPaths) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function normalizeExcludedPaths(root: string, values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const relative = path.isAbsolute(value) ? path.relative(root, path.resolve(value)) : value;
    const normalized = normalizeRelative(relative).replace(/\/+$/u, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) continue;
    result.add(normalized);
  }
  return result;
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
