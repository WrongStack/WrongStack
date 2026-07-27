/**
 * SessionRegistry — cross-process session and agent tracker.
 *
 * Each WrongStack process registers its session on start and updates its
 * status periodically. The registry is a single JSON file at
 * `~/.wrongstack/session-registry.json`. Entries are keyed by session ID.
 *
 * Because multiple processes may write concurrently, every write is an
 * atomic read-modify-write protected by a per-file advisory lock (flock on
 * Unix, exclusive open on Windows). Stale entries (process no longer alive)
 * are pruned on every read.
 *
 * @module session-registry
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPidAlive } from './utils/pid.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** Live status of a single agent within a session. */
export type AgentLiveStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user' // brain.ask_human, confirm prompt
  | 'error';

/** A bounded, display-safe tool receipt shared with cross-process observers. */
export interface AgentRecentTool {
  id: string;
  name: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  ok: boolean;
  input?: unknown | undefined;
  output?: string | undefined;
  inputLines?: number | undefined;
  oldLines?: number | undefined;
  newLines?: number | undefined;
  addedLines?: number | undefined;
  removedLines?: number | undefined;
  outputLines?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
}

export interface AgentRecentMail {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  type: string;
  subject: string;
  at: number;
}

/** A compact todo mirrored with the leader so every Office can show its live worklist. */
export interface AgentTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
}

/** Session-long aggregate used by project Office dashboards. */
export interface AgentActivityTotals {
  filesTouched: string[];
  reads: number;
  writes: number;
  edits: number;
  terminalCalls: number;
  webCalls: number;
  searches: number;
  otherCalls: number;
  mailReceived: number;
  mailSent: number;
  linesRead: number;
  linesWritten: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface AgentEntry {
  /** Unique agent id (ULID or UUID). */
  id: string;
  /** Human-readable label (e.g. "leader", "bug-hunter #1"). */
  name: string;
  /** UTC ISO timestamp when this agent/run started, when known. */
  startedAt?: string | undefined;
  status: AgentLiveStatus;
  /** Current tool name if running, undefined otherwise. */
  currentTool?: string | undefined;
  /** Human-readable task currently assigned to this agent. */
  currentTask?: string | undefined;
  /** Stable coordinator task id when this is a delegated/subagent task. */
  taskId?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** Cumulative cost in USD for this agent, when known. */
  costUsd?: number | undefined;
  /** Cumulative input tokens, when known. */
  tokensIn?: number | undefined;
  /** Cumulative output tokens, when known. */
  tokensOut?: number | undefined;
  /** Context window fill 0–100 (may exceed 100 when over limit), when known. */
  ctxPct?: number | undefined;
  /** Model id this agent is running on, when known. */
  model?: string | undefined;
  /**
   * Tail of the assistant text currently being streamed (capped, throttled).
   * Lets a cross-process watcher see the response form in near-real-time
   * instead of waiting for the completed turn to land in the session log.
   */
  partialText?: string | undefined;
  /** Recent completed tools, newest first. Bounded by AgentStatusTracker. */
  recentTools?: AgentRecentTool[] | undefined;
  recentMail?: AgentRecentMail[] | undefined;
  /** Session worklist. Populated on the leader entry only. */
  todos?: AgentTodoItem[] | undefined;
  /** Most recent operator prompt. Populated on the leader entry only. */
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  /** Cumulative activity for this live session, reset when the session ends. */
  activity?: AgentActivityTotals | undefined;
  /** UTC ISO timestamp of last activity. */
  lastActivityAt: string;
}

export type SessionLiveStatus =
  | 'active' // process running, agents may be idle or busy
  | 'idle' // process running, no agent activity
  | 'closing' // session_end written, process shutting down
  | 'stale' // process no longer alive (pruned on next read)
  | 'lost'; // heartbeat timeout — process may still be alive but unreachable

export interface SessionRegistryEntry {
  sessionId: string;
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
  /**
   * Which surface owns this session — `'tui'` / `'webui'` / `'cli'` (one-shot or
   * REPL). Lets cross-process consumers (e.g. the WebUI Fleet HQ office map) label
   * each live session by client kind. Optional for back-compat with older entries.
   */
  clientType?: 'tui' | 'webui' | 'cli' | 'repl' | string | undefined;
  /** Current git branch, if the project is a git repo. Detected at registration. */
  gitBranch?: string | undefined;
  status: SessionLiveStatus;
  pid: number;
  /** UTC ISO */
  startedAt: string;
  /** UTC ISO — updated on every heartbeat */
  lastHeartbeatAt: string;
  /** Count of tracked agents */
  agentCount: number;
  agents: AgentEntry[];
}

// ── Constants ─────────────────────────────────────────────────────────────

const REGISTRY_FILE = 'session-registry.json';
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_TIMEOUT_MS = 30_000; // entry considered stale after 30s without heartbeat
// A live session heartbeats every HEARTBEAT_INTERVAL_MS, so two missed beats
// already mean something is wrong — cheap enough to confirm with a PID probe
// from then on, instead of waiting out the full stale window.
const PID_CHECK_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2;
// A session that announced `closing` (heartbeat stopped) is dropped this long
// after its last heartbeat, so the fleet view doesn't keep a dead client around.
const CLOSING_GRACE_MS = 15_000;
// A live PID with a missed heartbeat is marked lost but retained. Removing it
// would let another process open the same journal while the original process
// can still write. Operators must terminate the live owner before takeover.
/** Subagents without any activity this long are not live, even if the owning session still heartbeats. */
const AGENT_STALE_MS = 5 * 60_000;
// A held lock is released within milliseconds; anything older is a crashed
// owner's leftover and is safe to break so writes never wedge permanently.
const STALE_LOCK_MS = 10_000;
// Ownership claims are rare and must survive ordinary Windows fsync/antivirus
// latency plus a burst of simultaneous heartbeats from several clients.
// Telemetry writes remain cheap/best-effort and keep the shorter budget.
const OWNERSHIP_LOCK_WAIT_MS = 8_000;
const OPTIONAL_LOCK_WAIT_MS = 750;
const LOCK_RETRY_MAX_MS = 100;
const STALE_TMP_MS = 60_000;
const MAX_STALE_TMP_FILES = 20;
// Agent snapshots arrive on every tool boundary — a busy agent can cross
// several boundaries per second, and each write is a full temp+fsync+rename
// under the advisory lock. Coalesce to at most one write per window; the
// first call in a quiet window still writes immediately so status stays live.
const AGENTS_WRITE_THROTTLE_MS = 300;

/** Conflict errors are the one registry-write failure callers must observe. */
class SessionOwnershipConflictError extends Error {}
class SessionRegistryWriteError extends Error {}
// Directory enumeration and per-file stats are substantially more expensive
// than the tiny registry write itself on networked/antivirus-scanned homes.
// Temp files cannot become stale faster than STALE_TMP_MS, so scanning once in
// that window is sufficient even though heartbeats write every five seconds.
const TEMP_PRUNE_INTERVAL_MS = STALE_TMP_MS;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Liveness probe for registry entries. Delegates to the shared helper so this
 * module can't drift back to the bare-catch variant, which reported a live
 * but non-signalable process (EPERM) as dead and pruned its session.
 */
const pidAlive = isPidAlive;

function sameOwner(
  entry: Pick<SessionRegistryEntry, 'pid' | 'startedAt'>,
  owner: Pick<SessionRegistryEntry, 'pid' | 'startedAt'>,
): boolean {
  return entry.pid === owner.pid && entry.startedAt === owner.startedAt;
}

/**
 * Parse registry file contents, tolerating corruption. A system crash can
 * leave the file zero-filled (NTFS journals the rename metadata but the data
 * blocks were never flushed — the file is its full size of NUL bytes), or a
 * torn write can leave invalid JSON. Treat anything unparsable — or parsable
 * but not a plain object — as an empty registry so the next write heals the
 * file instead of wedging every future write forever.
 */
function parseRegistry(raw: string): Record<string, SessionRegistryEntry> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, SessionRegistryEntry>;
    }
  } catch {
    /* corrupt file — fall through to empty */
  }
  return {};
}

/** Derive the session-level status from the agent collective. */
function deriveSessionStatus(agents: AgentEntry[]): SessionLiveStatus {
  const hasRunning = agents.some((a) => a.status === 'running' || a.status === 'streaming');
  const hasWaiting = agents.some((a) => a.status === 'waiting_user');
  const hasError = agents.some((a) => a.status === 'error');
  return hasRunning || hasWaiting || hasError ? 'active' : 'idle';
}

// ── Registry class ────────────────────────────────────────────────────────

export class SessionRegistry {
  private readonly filePath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private lastTempPruneAt = 0;
  private tempPrunePromise: Promise<void> | null = null;
  /** Latest agent snapshot not yet written; superseded by newer calls. */
  private pendingAgents: AgentEntry[] | null = null;
  /** Shared settle promise for all updateAgents calls coalesced into one trailing write. */
  private pendingAgentsFlush: Promise<void> | null = null;
  private pendingAgentsResolve: (() => void) | null = null;
  private agentsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAgentsWriteAt = 0;
  /**
   * Last full entry this process registered. Kept so the heartbeat can
   * re-create our entry if it ever goes missing because the file was reset or
   * a reader pruned a stale snapshot.
   */
  private lastEntry: SessionRegistryEntry | null = null;
  private readonly ownershipLockWaitMs: number;

  constructor(globalRoot: string, options: { ownershipLockWaitMs?: number } = {}) {
    this.filePath = path.join(globalRoot, REGISTRY_FILE);
    this.ownershipLockWaitMs = Math.max(0, options.ownershipLockWaitMs ?? OWNERSHIP_LOCK_WAIT_MS);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Register the current session. Call once on session start.
   * Starts the heartbeat timer.
   */
  async register(
    entry: Omit<SessionRegistryEntry, 'status' | 'lastHeartbeatAt' | 'agentCount' | 'agents'> & {
      agents?: AgentEntry[] | undefined;
    },
  ): Promise<void> {
    // Safe to call again on a project switch: the WebUI re-roots in place and
    // creates a fresh session id pointing at the new project. Clear the prior
    // heartbeat timer (otherwise each switch leaks a timer that keeps writing).
    // A process owns exactly one entry, so the same-pid dedup below drops our
    // own previous entry — the registry never carries a phantom session still
    // pointing at the old project's root/workingDir.
    const full: SessionRegistryEntry = {
      ...entry,
      status: 'active',
      lastHeartbeatAt: new Date().toISOString(),
      agentCount: entry.agents?.length ?? 0,
      agents: entry.agents ?? [],
    };
    // Fast pre-check for the common conflict path. The same check is repeated
    // under atomicUpdate's cross-process lock below to close the resume race.
    const existingRegistry = await this.readAndPrune();
    const currentOwner = existingRegistry[entry.sessionId];
    if (currentOwner && currentOwner.pid !== entry.pid && pidAlive(currentOwner.pid)) {
      throw new SessionOwnershipConflictError(
        `Session ${entry.sessionId} is already open in another running wstack (pid ${currentOwner.pid}).`,
      );
    }

    await this.atomicUpdate((registry) => {
      // Prune dead entries that haven't heartbeated recently.
      // A just-created entry has no heartbeat yet — don't prune it.
      const now = Date.now();
      for (const [id, existing] of Object.entries(registry)) {
        if (existing.pid === entry.pid) {
          // Our own process owns exactly one entry. When re-registering under
          // a new session id (project switch re-roots in place), drop the
          // stale same-pid entry so it doesn't linger pointing at the old
          // project's root/workingDir.
          if (id !== entry.sessionId) delete registry[id];
          continue;
        }
        const heartbeatAge = now - new Date(existing.lastHeartbeatAt).getTime();
        if (heartbeatAge > PID_CHECK_AFTER_MS && !pidAlive(existing.pid)) {
          delete registry[id];
        }
      }
      const lockedOwner = registry[entry.sessionId];
      if (lockedOwner && lockedOwner.pid !== entry.pid && pidAlive(lockedOwner.pid)) {
        throw new SessionOwnershipConflictError(
          `Session ${entry.sessionId} is already open in another running wstack (pid ${lockedOwner.pid}).`,
        );
      }
      registry[entry.sessionId] = full;
    }, true);
    // Only publish local ownership after the cross-process claim succeeds.
    // A failed duplicate-session claim must not make heartbeats overwrite the
    // real owner's registry entry.
    this.cancelPendingAgentsFlush();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.lastAgentsWriteAt = 0;
    this.currentSessionId = entry.sessionId;
    this.lastEntry = full;

    // Start heartbeat
    /* v8 ignore start -- 5s heartbeat timer fires only in a live process, not under test */
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    /* v8 ignore stop */
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Update agent status for the current session. Call on every
   * significant status change (agent start, tool start, user wait, error).
   *
   * Writes are coalesced: the first call in a quiet window writes
   * immediately; calls arriving within {@link AGENTS_WRITE_THROTTLE_MS} of
   * the last write collapse into one trailing write carrying the newest
   * snapshot. The in-memory cache ({@link lastEntry}) is always updated
   * synchronously, so heartbeat re-inserts never carry stale agents.
   */
  async updateAgents(agents: AgentEntry[]): Promise<void> {
    if (!this.currentSessionId) return;
    this.pendingAgents = agents;

    // Keep the cached entry current so a heartbeat re-insert carries live agents.
    if (this.lastEntry) {
      this.lastEntry.agents = agents;
      this.lastEntry.agentCount = agents.length;
      this.lastEntry.status = deriveSessionStatus(agents);
      this.lastEntry.lastHeartbeatAt = new Date().toISOString();
    }

    const sinceLastWrite = Date.now() - this.lastAgentsWriteAt;
    if (!this.agentsFlushTimer && sinceLastWrite >= AGENTS_WRITE_THROTTLE_MS) {
      await this.writeAgentsSnapshot();
      return;
    }

    if (!this.agentsFlushTimer) {
      const delay = Math.max(0, AGENTS_WRITE_THROTTLE_MS - sinceLastWrite);
      this.pendingAgentsFlush = new Promise<void>((resolve, reject) => {
        this.pendingAgentsResolve = resolve;
        const timer = setTimeout(() => {
          this.agentsFlushTimer = null;
          this.pendingAgentsFlush = null;
          this.pendingAgentsResolve = null;
          this.writeAgentsSnapshot().then(resolve, reject);
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        this.agentsFlushTimer = timer;
      });
    }
    await this.pendingAgentsFlush;
  }

  /** Write the newest pending agent snapshot to the registry file. */
  private async writeAgentsSnapshot(): Promise<void> {
    const agents = this.pendingAgents;
    const sessionId = this.currentSessionId;
    const owner = this.lastEntry;
    if (!agents || !sessionId || !owner || owner.sessionId !== sessionId) return;
    this.pendingAgents = null;
    this.lastAgentsWriteAt = Date.now();
    const status = deriveSessionStatus(agents);
    const nowIso = new Date().toISOString();

    await this.atomicUpdate((registry) => {
      if (this.currentSessionId !== sessionId || this.lastEntry !== owner) return;
      let entry = registry[sessionId];
      if (entry && !sameOwner(entry, owner)) return;
      if (!entry) {
        // Our entry vanished (dropped write / reset / pruned) — re-create it.
        entry = { ...owner };
        registry[sessionId] = entry;
      }
      entry.agents = agents;
      entry.agentCount = agents.length;
      entry.status = status;
      entry.lastHeartbeatAt = nowIso;
    });
  }

  /**
   * Cancel a scheduled trailing agents write (releasing any waiters). Used on
   * shutdown so a late timer can't resurrect an entry that markClosing() /
   * unregister() is about to finalize. Returns the snapshot that was pending.
   */
  private cancelPendingAgentsFlush(): AgentEntry[] | null {
    if (this.agentsFlushTimer) {
      clearTimeout(this.agentsFlushTimer);
      this.agentsFlushTimer = null;
    }
    this.pendingAgentsResolve?.();
    this.pendingAgentsResolve = null;
    this.pendingAgentsFlush = null;
    const pending = this.pendingAgents;
    this.pendingAgents = null;
    return pending;
  }

  /**
   * Mark the session as closing. Called during shutdown.
   * Stops the heartbeat timer.
   */
  async markClosing(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.currentSessionId) return;
    const sessionId = this.currentSessionId;
    const owner = this.lastEntry;
    if (!owner) return;
    // Fold any coalesced-but-unwritten agent snapshot into this final write so
    // the trailing timer can't fire later and flip us back to active.
    const pendingAgents = this.cancelPendingAgentsFlush();
    await this.atomicUpdate((registry) => {
      const entry = registry[sessionId];
      if (!entry || !sameOwner(entry, owner)) return;
      if (pendingAgents) {
        entry.agents = pendingAgents;
        entry.agentCount = pendingAgents.length;
      }
      entry.status = 'closing';
      entry.lastHeartbeatAt = new Date().toISOString();
    });
  }

  /**
   * Remove the current session from the registry. Call on clean exit.
   */
  async unregister(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.currentSessionId) return;
    // Drop any coalesced agent snapshot — the entry is being deleted, and a
    // late trailing write would resurrect it from lastEntry.
    this.cancelPendingAgentsFlush();
    const sid = this.currentSessionId;
    const owner = this.lastEntry;
    this.currentSessionId = null;
    this.lastEntry = null;
    await this.atomicUpdate((registry) => {
      const entry = registry[sid];
      if (owner && entry && sameOwner(entry, owner)) {
        delete registry[sid];
      }
    });
  }

  /**
   * List all non-stale sessions. Prunes stale entries automatically.
   */
  async list(): Promise<SessionRegistryEntry[]> {
    const registry = await this.readAndPrune();
    return Object.values(registry);
  }

  /**
   * Get a single session entry by ID. Returns undefined if not found or stale.
   */
  async get(sessionId: string): Promise<SessionRegistryEntry | undefined> {
    const registry = await this.readAndPrune();
    return registry[sessionId];
  }

  /**
   * List all sessions for a specific project (by slug).
   */
  async listByProject(projectSlug: string): Promise<SessionRegistryEntry[]> {
    const all = await this.list();
    return all.filter((e) => e.projectSlug === projectSlug);
  }

  /**
   * Return the registry file path. Useful for WebUI to watch/read.
   */
  get registryPath(): string {
    return this.filePath;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async heartbeat(): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      const sessionId = this.currentSessionId;
      const owner = this.lastEntry;
      if (!owner || owner.sessionId !== sessionId) return;
      const nowIso = new Date().toISOString();
      await this.atomicUpdate((registry) => {
        if (this.currentSessionId !== sessionId || this.lastEntry !== owner) return;
        const entry = registry[sessionId];
        if (entry) {
          if (!sameOwner(entry, owner)) return;
          entry.lastHeartbeatAt = nowIso;
          // Status bound: if closing, don't revert
          if (entry.status !== 'closing') {
            const hasRunning = (entry.agents ?? []).some(
              (a) => a.status === 'running' || a.status === 'streaming',
            );
            entry.status = hasRunning ? 'active' : 'idle';
          }
          return;
        }
        // Our entry was externally removed/reset. Re-create it only while this
        // exact ownership generation is still current; a heartbeat queued
        // before a session switch must never resurrect the previous session.
        registry[sessionId] = { ...owner, lastHeartbeatAt: nowIso };
      });
    } catch {
      // Best-effort heartbeat — never throw
    }
  }

  private async readAndPrune(): Promise<Record<string, SessionRegistryEntry>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const registry = parseRegistry(raw);
      const observed = new Map(
        Object.entries(registry).map(([id, entry]) => [
          id,
          { pid: entry.pid, lastHeartbeatAt: entry.lastHeartbeatAt },
        ]),
      );
      const now = Date.now();
      let pruned = false;

      for (const [id, entry] of Object.entries(registry)) {
        const heartbeatAt = Date.parse(entry.lastHeartbeatAt);
        if (!Number.isFinite(heartbeatAt)) {
          delete registry[id];
          pruned = true;
          continue;
        }
        const heartbeatAge = now - heartbeatAt;

        // A live session heartbeat does not prove every cached subagent still
        // exists. Keep the leader as the surface itself, but reap workers whose
        // activity stopped several minutes ago (the common shadow-agent ghost).
        const agents = Array.isArray(entry.agents) ? entry.agents : [];
        const liveAgents = agents.filter((agent) => {
          if (agent.id === 'leader') return true;
          const lastActivityAt = Date.parse(agent.lastActivityAt);
          return Number.isFinite(lastActivityAt) && now - lastActivityAt <= AGENT_STALE_MS;
        });
        if (liveAgents.length !== agents.length || entry.agentCount !== liveAgents.length) {
          entry.agents = liveAgents;
          entry.agentCount = liveAgents.length;
          pruned = true;
        }

        // A cleanly-closing session is removable after the grace only when its
        // process is actually gone. A hung cleanup can still hold the writer.
        if (entry.status === 'closing' && heartbeatAge > CLOSING_GRACE_MS) {
          if (!pidAlive(entry.pid)) {
            delete registry[id];
            pruned = true;
          }
          continue;
        }
        // A dead PID is definitive, and this probe used to sit behind the full
        // STALE_TIMEOUT_MS window. That meant a session killed without
        // `markClosing` (SIGKILL, taskkill /F, the rapid-Ctrl+C
        // `process.exit(130)` path) kept its last written status — for an idle
        // TUI, literally `'idle'` — so every reader showed a live-looking
        // session on a dead pid for up to 30s. Probing after two missed
        // heartbeats cuts that to ~10s while still leaving healthy entries
        // (which heartbeat every 5s) untouched on the hot read path.
        if (heartbeatAge > PID_CHECK_AFTER_MS && !pidAlive(entry.pid)) {
          delete registry[id];
          pruned = true;
          continue;
        }
        if (heartbeatAge <= STALE_TIMEOUT_MS) continue;

        // A live PID remains the owner even when its heartbeat is lost. It may
        // be wedged, but it can still hold and write the session journal.
        if (entry.status !== 'lost') {
          entry.status = 'lost';
          pruned = true;
        }
      }

      if (pruned) {
        // Merge the pruned snapshot under the same cross-process lock used by
        // registrations. Never rename an old full-file snapshot over a session
        // that another process registered after our read.
        await this.atomicUpdate((current) => {
          for (const [id, version] of observed) {
            const latest = current[id];
            if (
              !latest ||
              latest.pid !== version.pid ||
              latest.lastHeartbeatAt !== version.lastHeartbeatAt
            ) {
              continue;
            }
            const next = registry[id];
            if (next) current[id] = next;
            else delete current[id];
          }
        });
        /* v8 ignore stop */
      }

      return registry;
    } catch {
      return {};
    }
  }

  private async atomicUpdate(
    fn: (registry: Record<string, SessionRegistryEntry>) => void,
    required = false,
  ): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    const waitBudgetMs = required ? this.ownershipLockWaitMs : OPTIONAL_LOCK_WAIT_MS;
    const deadline = Date.now() + waitBudgetMs;
    let attempt = 0;

    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // Directory scans are independent cleanup work and can be slow on
      // Windows/antivirus-scanned homes. Never hold the registry mutex while
      // pruning old temp files.
      await this.maybePruneStaleTempFiles();
    } catch (err) {
      if (required) {
        throw new SessionRegistryWriteError(
          `Session registry ownership update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    while (true) {
      try {
        // Acquire exclusive lock via O_CREAT | O_EXCL
        let lockHandle = await fs.open(lockPath, 'wx').catch(() => null);
        if (!lockHandle) {
          // Lock contended. A crashed process can leave its lock file behind
          // forever (the `finally` unlink never ran), which would wedge EVERY
          // future write — the registry silently stops updating. Break the lock
          // when its owner pid is dead or it has been held implausibly long
          // (legit holds are sub-millisecond), then retry the open once.
          if (await this.breakStaleLock(lockPath)) {
            /* v8 ignore start -- retry-open after breaking a stale lock; .catch only fires on contention */
            lockHandle = await fs.open(lockPath, 'wx').catch(() => null);
            /* v8 ignore stop */
          }
          if (!lockHandle) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            const retryDelayMs = Math.min(LOCK_RETRY_MAX_MS, 20 * (attempt + 1));
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(retryDelayMs, remainingMs)),
            );
            attempt += 1;
            continue;
          }
        }

        try {
          // Stamp the owner pid so other processes can detect a stale lock.
          /* v8 ignore start -- best-effort owner-pid stamp; .catch only fires on a write failure */
          await lockHandle.writeFile(String(process.pid)).catch(() => undefined);
          /* v8 ignore stop */
          const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '{}');
          // Corruption-tolerant: a crash-zeroed or torn file must not abort
          // the write — starting from {} rewrites a healthy registry.
          const registry = parseRegistry(raw);
          fn(registry);
          await this.writeAtomicLocked(registry);
          return; // success
        } finally {
          await lockHandle.close();
          /* v8 ignore start -- best-effort lock cleanup in finally; .catch only fires if the lock vanished */
          await fs.unlink(lockPath).catch(() => undefined);
          /* v8 ignore stop */
        }
      } catch (err) {
        if (err instanceof SessionOwnershipConflictError) throw err;
        if (required) {
          throw new SessionRegistryWriteError(
            `Session registry ownership update failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Telemetry/cleanup writes remain best-effort.
        return;
      }
    }
    if (required) {
      throw new SessionRegistryWriteError(
        `Session registry ownership update failed: lock remained busy for ${waitBudgetMs}ms at ${lockPath}`,
      );
    }
    // All retries exhausted — non-ownership telemetry update dropped.
  }

  /**
   * Break a contended lock if it is stale: the recorded owner pid is no longer
   * alive, or the lock is older than {@link STALE_LOCK_MS}. Returns true when the
   * lock was removed (caller should retry acquisition). Best-effort and
   * race-tolerant — a fresh lock (age ~0, live owner) is never broken, so the
   * common concurrent case self-heals on the next heartbeat.
   */
  private async breakStaleLock(lockPath: string): Promise<boolean> {
    try {
      const [stat, content] = await Promise.all([
        fs.stat(lockPath),
        /* v8 ignore start -- best-effort lock-content read; .catch only fires if the lock vanished */
        fs.readFile(lockPath, 'utf8').catch(() => ''),
        /* v8 ignore stop */
      ]);
      const ageMs = Date.now() - stat.mtimeMs;
      const ownerPid = Number.parseInt(content.trim(), 10);
      const ownerDead =
        Number.isInteger(ownerPid) &&
        ownerPid > 0 &&
        ownerPid !== process.pid &&
        !pidAlive(ownerPid);
      if (ownerDead || ageMs > STALE_LOCK_MS) {
        /* v8 ignore start -- best-effort stale-lock removal; .catch only fires if the lock vanished */
        await fs.unlink(lockPath).catch(() => undefined);
        /* v8 ignore stop */
        return true;
      }
      return false;
    } catch {
      // stat failed → the lock vanished underneath us; let the caller retry.
      /* v8 ignore next -- defensive: a vanished lock between stat and read is fine */
      return true;
    }
  }

  private async writeAtomicLocked(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    await this.writeAtomicFile(registry);
  }

  private async maybePruneStaleTempFiles(): Promise<void> {
    if (this.tempPrunePromise) {
      await this.tempPrunePromise;
      return;
    }
    const now = Date.now();
    if (now - this.lastTempPruneAt < TEMP_PRUNE_INTERVAL_MS) return;

    this.lastTempPruneAt = now;
    this.tempPrunePromise = this.pruneStaleTempFiles();
    try {
      await this.tempPrunePromise;
    } finally {
      this.tempPrunePromise = null;
    }
  }

  private async writeAtomicFile(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    const tmp = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    try {
      // Write + fsync BEFORE the rename: without the fsync, a system crash
      // can journal the rename metadata while the data blocks were never
      // flushed, leaving a zero-filled (all-NUL) registry file on reboot.
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(JSON.stringify(registry, null, 2), 'utf8');
        await handle.sync().catch(() => undefined);
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      /* v8 ignore start -- rename-failure cleanup: best-effort tmp unlink + rethrow (atomicUpdate swallows it) */
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
      /* v8 ignore stop */
    }
  }

  private async pruneStaleTempFiles(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const now = Date.now();
      const stale: Array<{ name: string; mtimeMs: number }> = [];

      for (const name of await fs.readdir(dir)) {
        const isTemp =
          (name.startsWith(`${base}.`) || name.startsWith(`.${base}.`)) && name.endsWith('.tmp');
        if (!isTemp) continue;
        /* v8 ignore start -- best-effort temp stat; .catch(null)+continue only fire when the temp vanished */
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!stat) continue;
        /* v8 ignore stop */
        if (now - stat.mtimeMs > STALE_TMP_MS) stale.push({ name, mtimeMs: stat.mtimeMs });
      }

      stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
      await Promise.all(
        stale.slice(MAX_STALE_TMP_FILES).map(async ({ name }) => {
          /* v8 ignore start -- best-effort temp removal; .catch only fires if the temp vanished */
          await fs.unlink(path.join(dir, name)).catch(() => undefined);
          /* v8 ignore stop */
        }),
      );
    } catch {
      // best-effort cleanup must not block registry heartbeats
    }
  }
}

/** Singleton — created once per process. */
let _instance: SessionRegistry | null = null;

export function getSessionRegistry(globalRoot?: string): SessionRegistry {
  if (!_instance && globalRoot) {
    _instance = new SessionRegistry(globalRoot);
  }
  if (!_instance) {
    /* v8 ignore next -- the singleton is initialized by the first call in every test/process */
    throw new Error('SessionRegistry not initialized. Call getSessionRegistry(globalRoot) first.');
  }
  return _instance;
}

export function hasSessionRegistry(): boolean {
  return _instance !== null;
}
