import type {
  HqKanbanBoardRecord,
  HqKanbanSnapshotPayload,
  HqKanbanTombstone,
  HqPublisher,
} from '@wrongstack/core/hq';
import {
  deriveHqProjectId,
  MAX_HQ_KANBAN_BOARD_BYTES,
  redactHqEventPayload,
} from '@wrongstack/core/hq';
import {
  bridgeKanbanSupervisor,
  deleteBoard,
  type KanbanBoard,
  listBoardIds,
  readBoard,
  readKanbanMetadata,
  writeBoard,
  writeKanbanMetadata,
} from '@wrongstack/kanban';

interface LocalSyncState {
  boards: Record<string, { revision: number; updatedAt: string }>;
  tombstones: Record<string, HqKanbanTombstone>;
}

interface KanbanHqSync {
  attachPublisher(publisher: HqPublisher): Promise<void>;
  handleRemote(snapshot: HqKanbanSnapshotPayload): Promise<void>;
  /** Explicit refresh seam for hosts/tests; daemon events call the same path. */
  refresh(boardId?: string): void;
  getStats(): KanbanHqSyncStats;
  stop(): void;
}

export interface KanbanHqSyncStats {
  localPublishActive: boolean;
  pendingBoardIds: number;
  fullRescanPending: boolean;
  remoteApplyQueued: boolean;
  pendingRemoteBoards: number;
  localPublishRuns: number;
  coalescedLocalRefreshes: number;
}

const SYNC_STATE_KEY = 'hq-sync-state-v1';
// The HQ WebSocket server deliberately caps inbound frames at 1 MiB. Keep
// project-state payloads comfortably below that limit so the event envelope,
// UTF-8 expansion, and future protocol metadata still have headroom.
const MAX_KANBAN_SNAPSHOT_PAYLOAD_BYTES = 512 * 1024;
const KANBAN_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Cap the number of boards read per publish cycle so a large project doesn't
// load hundreds of board payloads in a single burst. Remaining boards spill to
// the next cycle.
const MAX_BOARDS_PER_PUBLISH = 50;

/**
 * Summary cap handed to `publishEvent` for kanban snapshots, and therefore the
 * cap `hqWireBoardBytes` must measure against. One constant so the estimate and
 * the actual send cannot drift apart.
 */
const KANBAN_SNAPSHOT_SUMMARY_CAP = 100_000;

// Kanban↔HQ sync is best-effort telemetry: every detached promise in this
// module must land here instead of surfacing as an unhandled rejection (which
// kills the host process on Node ≥15).
//
// A publish that THROWS self-heals: the throw skips `writeState`, so the state
// fingerprint stays unwritten and the next watcher event re-detects the same
// diff. That is only true of throws. A publish that succeeds locally but is
// rejected by HQ does not self-heal — `writeState` has already run by then, and
// the receiver drops an invalid frame without replying. (An earlier version of
// this comment claimed the retry covered that case too; it never did. The
// oversized-board skip above is what closes it.)
function warnSyncFailure(error: unknown): void {
  process.emitWarning(
    `WrongStack kanban HQ sync failed (best-effort, will retry on next change): ${
      error instanceof Error ? error.message : String(error)
    }`,
    { code: 'WRONGSTACK_HQ_KANBAN_SYNC_FAILED' },
  );
}

export function createKanbanHqSync(
  projectRoot: string,
  projectId = deriveHqProjectId(projectRoot),
  testHooks: { beforeLocalPublish?: (() => Promise<void>) | undefined } = {},
): KanbanHqSync {
  let publisher: HqPublisher | undefined;
  let unsubscribeDaemon: (() => void) | undefined;
  let daemonConnectionCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pendingBoardIds = new Set<string>();
  let fullRescanPending = false;
  let applyingRemote = false;
  let stopped = false;
  let operationChain: Promise<void> = Promise.resolve();
  let localPublishActive = false;
  let localPublishRuns = 0;
  let coalescedLocalRefreshes = 0;
  // Remote snapshots waiting to be applied, coalesced per boardId (latest
  // revision wins). Applying a snapshot does one IPC read/write per board;
  // when snapshots arrive faster than the owner can commit them, queueing each one
  // individually on `operationChain` retains every payload in memory — an
  // unbounded queue that has driven long fleet sessions into OOM. Coalescing
  // bounds pending memory to one record per distinct board.
  let pendingRemote: HqKanbanSnapshotPayload | null = null;
  let remoteApplyQueued = false;

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    operationChain = operationChain.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  };

  // Schedule the next publish cycle with a fixed debounce. The caller
  // (schedulePublish) already collapses rapid events into one batch, and
  // runExclusive serializes execution — no Date.now()-based interval is
  // needed because the 100ms debounce plus serialization chain already
  // prevents back-to-back publish bursts.
  const scheduleNext = (): void => {
    if (stopped || timer !== undefined || localPublishActive || applyingRemote) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || localPublishActive) return;
      localPublishActive = true;
      void runExclusive(async () => {
        const rescan = fullRescanPending;
        const dirtyBoardIds = [...pendingBoardIds];
        fullRescanPending = false;
        pendingBoardIds.clear();
        localPublishRuns++;
        await testHooks.beforeLocalPublish?.();
        await publishLocal(false, rescan ? undefined : dirtyBoardIds);
      })
        .catch(warnSyncFailure)
        .finally(() => {
          localPublishActive = false;
          if (!stopped && (fullRescanPending || pendingBoardIds.size > 0)) scheduleNext();
        });
    }, 100);
    timer.unref?.();
  };

  const schedulePublish = (boardId: string | null): void => {
    if (stopped || applyingRemote || publisher === undefined) return;
    if (boardId === null) fullRescanPending = true;
    else pendingBoardIds.add(boardId);
    if (timer !== undefined || localPublishActive) coalescedLocalRefreshes++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    scheduleNext();
  };

  const publishLocal = async (
    fullSnapshot: boolean,
    dirtyBoardIds?: readonly string[],
  ): Promise<void> => {
    const target = publisher;
    if (target === undefined || stopped) return;
    const state = await readState(projectRoot);
    const prunedTombstones = pruneExpiredTombstones(state, Date.now());
    let stateChanged = fullSnapshot || prunedTombstones;
    const boards: HqKanbanBoardRecord[] = [];
    const tombstones: HqKanbanTombstone[] = [];
    const fullScan = fullSnapshot || dirtyBoardIds === undefined;
    const allBoardIds: readonly string[] = fullScan
      ? await listBoardIds(projectRoot)
      : dirtyBoardIds;
    let boardIds = allBoardIds;

    // Batch limit: only cap true delta publishes, never a full scan (initial
    // snapshot OR full rescan). When fullScan is true, ALL boards must be
    // loaded into `present` so the deletion-detection loop below does NOT
    // false-tombstone the boards this cycle didn't reach.
    if (!fullScan && boardIds.length > MAX_BOARDS_PER_PUBLISH) {
      for (const id of boardIds.slice(MAX_BOARDS_PER_PUBLISH)) {
        pendingBoardIds.add(id);
      }
      scheduleNext();
      boardIds = boardIds.slice(0, MAX_BOARDS_PER_PUBLISH);
    }

    const present = new Set<string>();
    const now = new Date().toISOString();
    for (const boardId of boardIds) {
      const board = await readBoard(projectRoot, boardId);
      if (board === null) {
        const known = state.boards[boardId];
        if (known !== undefined && state.tombstones[boardId] === undefined) {
          const tombstone = {
            boardId,
            revision: known.revision + 1,
            deletedAt: now,
          };
          state.tombstones[boardId] = tombstone;
          tombstones.push(tombstone);
          stateChanged = true;
        }
        continue;
      }
      present.add(boardId);
      const record = boardRecord(board);
      // `isHqKanbanSnapshotPayload` rejects the entire snapshot when one board
      // record is over the limit, and HQ drops a rejected frame without a
      // reply — so an oversized board simply stopped appearing in HQ and
      // nothing anywhere said so. The fingerprint had already been written by
      // then, so it never retried either: permanent, silent, invisible.
      //
      // (Its chunk-mates were never at risk: the chunk target above is 512 KB
      // and the reject threshold is 750 KB, so any board big enough to be
      // rejected is already alone in its chunk. The loss is one board, not a
      // batch — which is why the fix is a warning and a retry, not isolation.)
      //
      // Skipping it here means the frame stays valid, and leaving the
      // fingerprint unwritten means the board is retried once it shrinks.
      const wireBytes = hqWireBoardBytes(record.board, target.redactionPolicy);
      if (wireBytes > MAX_HQ_KANBAN_BOARD_BYTES) {
        process.emitWarning(
          `Kanban board "${boardId}" serializes to ${wireBytes} bytes for HQ, over the ${MAX_HQ_KANBAN_BOARD_BYTES}-byte per-board limit. It will not appear in HQ until it shrinks; archive completed cards.`,
          { code: 'WRONGSTACK_HQ_KANBAN_BOARD_DROPPED' },
        );
        continue;
      }
      const known = state.boards[boardId];
      const hadTombstone = state.tombstones[boardId] !== undefined;
      if (
        fullSnapshot ||
        hadTombstone ||
        known === undefined ||
        compareVersions(known.revision, known.updatedAt, record.revision, record.updatedAt) !== 0
      ) {
        boards.push(record);
      }
      if (
        known === undefined ||
        known.revision !== record.revision ||
        known.updatedAt !== record.updatedAt ||
        hadTombstone
      ) {
        stateChanged = true;
      }
      state.boards[boardId] = { revision: record.revision, updatedAt: record.updatedAt };
      delete state.tombstones[boardId];
    }
    if (fullScan) {
      for (const [boardId, known] of Object.entries(state.boards)) {
        if (
          present.has(boardId) ||
          state.tombstones[boardId] !== undefined ||
          isExpiredVersion(known.updatedAt, Date.now())
        ) {
          continue;
        }
        const tombstone = {
          boardId,
          revision: known.revision + 1,
          deletedAt: now,
        };
        state.tombstones[boardId] = tombstone;
        tombstones.push(tombstone);
        stateChanged = true;
      }
    }
    if (stateChanged) await writeState(projectRoot, state);

    // A filesystem event caused by applying an HQ snapshot often arrives after
    // `applyingRemote` has been cleared. The persisted state fingerprint above
    // lets that event collapse to an empty delta instead of echoing the entire
    // project back to HQ and starting an N-client broadcast storm.
    if (!fullSnapshot && boards.length === 0 && tombstones.length === 0) return;

    for (const payload of chunkSnapshotPayload(
      projectId,
      now,
      boards,
      fullSnapshot ? Object.values(state.tombstones) : tombstones,
    )) {
      target.publishEvent({
        type: 'kanban.snapshot',
        payload,
        maxSummaryLength: KANBAN_SNAPSHOT_SUMMARY_CAP,
      });
    }
  };

  const attachPublisher = (next: HqPublisher): Promise<void> => {
    publisher = next;
    return runExclusive(async () => {
      if (
        unsubscribeDaemon === undefined &&
        (process.env['NODE_ENV'] !== 'test' || process.env['WRONGSTACK_KANBAN_FORCE_IPC'] === '1')
      ) {
        unsubscribeDaemon = bridgeKanbanSupervisor(
          projectRoot,
          (event) => {
            const data = event.data as { boardId?: string } | undefined;
            // Non-board-scoped events conservatively request a full rescan.
            schedulePublish(data?.boardId ?? null);
          },
          {
            autoReconnect: true,
            reconnectDelayMs: 1_000,
            // Events emitted while the daemon was down cannot be replayed.
            // Reconcile the authoritative snapshot after every connection.
            onConnected: () => {
              daemonConnectionCount++;
              if (daemonConnectionCount > 1) schedulePublish(null);
            },
          },
        );
      }
      await publishLocal(true);
    });
  };

  const applyRemote = async (snapshot: HqKanbanSnapshotPayload): Promise<void> => {
    if (snapshot.projectId !== projectId || stopped) return;
    applyingRemote = true;
    try {
      const state = await readState(projectRoot);
      for (const remote of snapshot.boards) {
        const local = await readBoard(projectRoot, remote.boardId);
        if (
          local !== null &&
          compareVersions(
            local.revision ?? 0,
            local.updatedAt,
            remote.revision,
            remote.updatedAt,
          ) >= 0
        ) {
          continue;
        }
        await writeBoard(projectRoot, remote.board as unknown as KanbanBoard);
        state.boards[remote.boardId] = {
          revision: remote.revision,
          updatedAt: remote.updatedAt,
        };
        delete state.tombstones[remote.boardId];
      }
      for (const tombstone of snapshot.tombstones) {
        const local = await readBoard(projectRoot, tombstone.boardId);
        if (
          local !== null &&
          compareVersions(
            local.revision ?? 0,
            local.updatedAt,
            tombstone.revision,
            tombstone.deletedAt,
          ) >= 0
        ) {
          continue;
        }
        if (local !== null) await deleteBoard(projectRoot, tombstone.boardId);
        state.boards[tombstone.boardId] = {
          revision: Math.max(0, tombstone.revision - 1),
          updatedAt: tombstone.deletedAt,
        };
        state.tombstones[tombstone.boardId] = tombstone;
      }
      await writeState(projectRoot, state);
    } finally {
      applyingRemote = false;
    }
  };

  const handleRemote = (snapshot: HqKanbanSnapshotPayload): Promise<void> => {
    if (snapshot.projectId !== projectId || stopped) return Promise.resolve();
    pendingRemote =
      pendingRemote === null ? snapshot : coalesceRemoteSnapshots(pendingRemote, snapshot);
    // At most one apply pass is ever queued: it drains whatever has been
    // coalesced by the time it runs, so bursts collapse instead of chaining.
    if (remoteApplyQueued) return Promise.resolve();
    remoteApplyQueued = true;
    return runExclusive(async () => {
      remoteApplyQueued = false;
      const batch = pendingRemote;
      pendingRemote = null;
      if (batch !== null) await applyRemote(batch);
    }).catch(warnSyncFailure);
  };

  return {
    attachPublisher,
    handleRemote,
    refresh: (boardId?: string) => schedulePublish(boardId ?? null),
    getStats: () => ({
      localPublishActive,
      pendingBoardIds: pendingBoardIds.size,
      fullRescanPending,
      remoteApplyQueued,
      pendingRemoteBoards: pendingRemote?.boards.length ?? 0,
      localPublishRuns,
      coalescedLocalRefreshes,
    }),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      pendingBoardIds.clear();
      fullRescanPending = false;
      pendingRemote = null;
      unsubscribeDaemon?.();
      unsubscribeDaemon = undefined;
      publisher = undefined;
    },
  };
}

/**
 * Bytes this board will occupy on the wire — measured through the SAME redaction
 * the publisher will apply, not an approximation of it.
 *
 * Two things make that distinction load-bearing, and both were learned the hard
 * way against a live HQ:
 *
 *  - `publishEvent` summarises every string over `KANBAN_SNAPSHOT_SUMMARY_CAP`
 *    before sending, so a board that is large only because ONE field is long
 *    shrinks below the limit and arrives fine. Measuring the raw board would
 *    drop it — trading a truncated description for a board that never appears.
 *    The boards that genuinely cannot fit are the ones with hundreds of cards,
 *    where no single string is long enough to summarise.
 *  - `kanban.snapshot` is a project-state event, so raw-content keys survive
 *    redaction. The generic `redactHqValue` helper replaces them with a short
 *    marker instead; measuring through it under a `rawContent: false` policy
 *    produced an estimate SMALLER than the real payload, which would let an
 *    oversized board through to be silently rejected. `redactHqEventPayload`
 *    takes the event type, so the mode cannot drift from the send.
 *
 * The publisher's own resolved policy is passed in for the same reason: a
 * configured policy redacts differently from the default, and guessing which
 * way is how the previous version got it wrong.
 *
 * The cheap raw check runs first, so the deep walk only happens for boards that
 * look too big; everything else costs one `JSON.stringify`.
 */
function hqWireBoardBytes(
  board: Record<string, unknown>,
  policy: HqPublisher['redactionPolicy'],
): number {
  const raw = Buffer.byteLength(JSON.stringify(board), 'utf8');
  if (raw <= MAX_HQ_KANBAN_BOARD_BYTES) return raw;
  const redacted = redactHqEventPayload('kanban.snapshot', board, {
    policy,
    maxSummaryLength: KANBAN_SNAPSHOT_SUMMARY_CAP,
  }).value;
  return Buffer.byteLength(JSON.stringify(redacted), 'utf8');
}

function boardRecord(board: KanbanBoard): HqKanbanBoardRecord {
  return {
    boardId: board.id,
    revision: board.revision ?? 0,
    updatedAt: board.updatedAt,
    board: structuredClone(board) as unknown as Record<string, unknown>,
  };
}

function chunkSnapshotPayload(
  projectId: string,
  generatedAt: string,
  boards: HqKanbanBoardRecord[],
  tombstones: HqKanbanTombstone[],
): HqKanbanSnapshotPayload[] {
  const chunks: HqKanbanSnapshotPayload[] = [];
  const emptyPayload = (): HqKanbanSnapshotPayload => ({
    projectId,
    generatedAt,
    boards: [],
    tombstones: [],
  });
  const emptyPayloadBytes = Buffer.byteLength(JSON.stringify(emptyPayload()), 'utf8');
  let currentBoards: HqKanbanBoardRecord[] = [];
  let currentTombstones: HqKanbanTombstone[] = [];
  let currentBytes = emptyPayloadBytes;

  const pushCurrent = (): void => {
    if (currentBoards.length === 0 && currentTombstones.length === 0) return;
    chunks.push({
      projectId,
      generatedAt,
      boards: currentBoards,
      tombstones: currentTombstones,
    });
    currentBoards = [];
    currentTombstones = [];
    currentBytes = emptyPayloadBytes;
  };

  const append = (
    kind: 'boards' | 'tombstones',
    item: HqKanbanBoardRecord | HqKanbanTombstone,
  ): void => {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const itemCount = kind === 'boards' ? currentBoards.length : currentTombstones.length;
    const additionalBytes = itemBytes + (itemCount > 0 ? 1 : 0);
    if (emptyPayloadBytes + itemBytes > MAX_KANBAN_SNAPSHOT_PAYLOAD_BYTES) {
      process.emitWarning(
        `Kanban ${kind === 'boards' ? 'board' : 'tombstone'} ${item.boardId} exceeds the ${MAX_KANBAN_SNAPSHOT_PAYLOAD_BYTES}-byte snapshot chunk target`,
        { code: 'WRONGSTACK_HQ_KANBAN_OVERSIZED_RECORD' },
      );
    }
    if (
      (currentBoards.length > 0 || currentTombstones.length > 0) &&
      currentBytes + additionalBytes > MAX_KANBAN_SNAPSHOT_PAYLOAD_BYTES
    ) {
      pushCurrent();
    }
    if (kind === 'boards') {
      currentBoards.push(item as HqKanbanBoardRecord);
    } else {
      currentTombstones.push(item as HqKanbanTombstone);
    }
    currentBytes +=
      itemBytes +
      (kind === 'boards'
        ? currentBoards.length > 1
          ? 1
          : 0
        : currentTombstones.length > 1
          ? 1
          : 0);
  };

  for (const board of boards) append('boards', board);
  for (const tombstone of tombstones) append('tombstones', tombstone);
  pushCurrent();

  // An empty snapshot is meaningful on first attach: it registers the project
  // state channel even when the project has no boards yet.
  const result = chunks.length > 0 ? chunks : [emptyPayload()];
  // Stamp the ordinals only on a genuine split. The publisher's offline queue
  // coalesces `*.snapshot` frames by scope; without a per-chunk discriminator
  // every chunk of one publish shared a key and evicted its predecessor, so a
  // reconnect delivered the last chunk alone. A single-chunk publish needs no
  // discriminator and does not carry the fields.
  if (result.length > 1) {
    result.forEach((payload, index) => {
      payload.chunkIndex = index;
      payload.chunkCount = result.length;
    });
  }
  return result;
}

/** Merge two pending remote snapshots into one, keeping — per boardId — the
 *  record with the highest (revision, timestamp), whether board or tombstone.
 *  Equivalent to applying both snapshots in arrival order when revisions are
 *  monotonically increasing (which HQ guarantees in practice): the only
 *  divergence is a lower-revision board arriving after a higher-revision
 *  tombstone for the same boardId, where coalescing correctly keeps the
 *  tombstone whereas naive sequential apply would resurrect the stale board. */
function coalesceRemoteSnapshots(
  older: HqKanbanSnapshotPayload,
  newer: HqKanbanSnapshotPayload,
): HqKanbanSnapshotPayload {
  type RemoteRecord =
    | { kind: 'board'; revision: number; time: string; record: HqKanbanBoardRecord }
    | { kind: 'tombstone'; revision: number; time: string; record: HqKanbanTombstone };
  const byBoardId = new Map<string, RemoteRecord>();
  const put = (candidate: RemoteRecord, boardId: string): void => {
    const existing = byBoardId.get(boardId);
    // On a full (revision, time) tie, prefer the newer-arriving record so a
    // same-timestamp content update in the second snapshot is not silently
    // discarded in favor of the older-arriving one.
    if (
      existing === undefined ||
      compareVersions(existing.revision, existing.time, candidate.revision, candidate.time) <= 0
    ) {
      byBoardId.set(boardId, candidate);
    }
  };
  for (const snapshot of [older, newer]) {
    for (const record of snapshot.boards) {
      put(
        { kind: 'board', revision: record.revision, time: record.updatedAt, record },
        record.boardId,
      );
    }
    for (const record of snapshot.tombstones) {
      put(
        { kind: 'tombstone', revision: record.revision, time: record.deletedAt, record },
        record.boardId,
      );
    }
  }
  const merged: HqKanbanSnapshotPayload = {
    projectId: newer.projectId,
    generatedAt: newer.generatedAt,
    boards: [],
    tombstones: [],
  };
  for (const entry of byBoardId.values()) {
    if (entry.kind === 'board') merged.boards.push(entry.record);
    else merged.tombstones.push(entry.record);
  }
  return merged;
}

function compareVersions(
  aRevision: number,
  aTime: string,
  bRevision: number,
  bTime: string,
): number {
  if (aRevision !== bRevision) return aRevision - bRevision;
  return aTime.localeCompare(bTime);
}

function isExpiredVersion(timestamp: string, now: number): boolean {
  const parsed = Date.parse(timestamp);
  return !Number.isNaN(parsed) && parsed <= now - KANBAN_TOMBSTONE_RETENTION_MS;
}

function pruneExpiredTombstones(state: LocalSyncState, now: number): boolean {
  let changed = false;
  for (const [boardId, tombstone] of Object.entries(state.tombstones)) {
    if (!isExpiredVersion(tombstone.deletedAt, now)) continue;
    delete state.tombstones[boardId];
    delete state.boards[boardId];
    changed = true;
  }
  return changed;
}

async function readState(projectRoot: string): Promise<LocalSyncState> {
  try {
    const raw = await readKanbanMetadata(projectRoot, SYNC_STATE_KEY);
    if (raw === null) return { boards: {}, tombstones: {} };
    const parsed = JSON.parse(raw) as Partial<LocalSyncState>;
    return { boards: parsed.boards ?? {}, tombstones: parsed.tombstones ?? {} };
  } catch {
    return { boards: {}, tombstones: {} };
  }
}

async function writeState(projectRoot: string, state: LocalSyncState): Promise<void> {
  await writeKanbanMetadata(projectRoot, SYNC_STATE_KEY, JSON.stringify(state));
}
