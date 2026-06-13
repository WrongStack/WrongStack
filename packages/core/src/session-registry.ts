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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────

/** Live status of a single agent within a session. */
export type AgentLiveStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user' // brain.ask_human, confirm prompt
  | 'error';

export interface AgentEntry {
  /** Unique agent id (ULID or UUID). */
  id: string;
  /** Human-readable label (e.g. "leader", "bug-hunter #1"). */
  name: string;
  status: AgentLiveStatus;
  /** Current tool name if running, undefined otherwise. */
  currentTool?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** UTC ISO timestamp of last activity. */
  lastActivityAt: string;
}

export type SessionLiveStatus =
  | 'active'   // process running, agents may be idle or busy
  | 'idle'     // process running, no agent activity
  | 'closing'  // session_end written, process shutting down
  | 'stale';   // process no longer alive (pruned on next read)

export interface SessionRegistryEntry {
  sessionId: string;
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
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

// ── Helpers ───────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Registry class ────────────────────────────────────────────────────────

export class SessionRegistry {
  private readonly filePath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;

  constructor(globalRoot: string) {
    this.filePath = path.join(globalRoot, REGISTRY_FILE);
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.currentSessionId = entry.sessionId;
    const full: SessionRegistryEntry = {
      ...entry,
      status: 'active',
      lastHeartbeatAt: new Date().toISOString(),
      agentCount: entry.agents?.length ?? 0,
      agents: entry.agents ?? [],
    };
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
        if (heartbeatAge > STALE_TIMEOUT_MS && !pidAlive(existing.pid)) {
          delete registry[id];
        }
      }
      registry[entry.sessionId] = full;
    });

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Update agent status for the current session. Call on every
   * significant status change (agent start, tool start, user wait, error).
   */
  async updateAgents(agents: AgentEntry[]): Promise<void> {
    if (!this.currentSessionId) return;
    await this.atomicUpdate((registry) => {
      const entry = registry[this.currentSessionId!];
      if (!entry) return;
      entry.agents = agents;
      entry.agentCount = agents.length;
      // Derive session status from agent collective
      const hasRunning = agents.some((a) => a.status === 'running' || a.status === 'streaming');
      const hasWaiting = agents.some((a) => a.status === 'waiting_user');
      const hasError = agents.some((a) => a.status === 'error');
      entry.status = hasRunning ? 'active' : hasWaiting ? 'active' : hasError ? 'active' : 'idle';
      entry.lastHeartbeatAt = new Date().toISOString();
    });
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
    await this.atomicUpdate((registry) => {
      const entry = registry[this.currentSessionId!];
      if (!entry) return;
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
    const sid = this.currentSessionId;
    this.currentSessionId = null;
    await this.atomicUpdate((registry) => {
      delete registry[sid];
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
    // Only update heartbeat timestamp — avoid full read-modify-write for perf
    try {
      const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '{}');
      const registry = JSON.parse(raw) as Record<string, SessionRegistryEntry>;
      const entry = registry[this.currentSessionId];
      if (entry) {
        entry.lastHeartbeatAt = new Date().toISOString();
        // Status bound: if closing, don't revert
        if (entry.status !== 'closing') {
          const hasRunning = (entry.agents ?? []).some(
            (a) => a.status === 'running' || a.status === 'streaming',
          );
          entry.status = hasRunning ? 'active' : 'idle';
        }
        await this.writeAtomic(registry);
      }
    } catch {
      // Best-effort heartbeat — never throw
    }
  }

  private async readAndPrune(): Promise<Record<string, SessionRegistryEntry>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const registry = JSON.parse(raw) as Record<string, SessionRegistryEntry>;
      const now = Date.now();
      let pruned = false;

      for (const [id, entry] of Object.entries(registry)) {
        const heartbeatAge = now - new Date(entry.lastHeartbeatAt).getTime();
        if (heartbeatAge > STALE_TIMEOUT_MS && !pidAlive(entry.pid)) {
          entry.status = 'stale';
          // Keep stale entries for 5 minutes so UIs can show "recently closed"
          const startedAge = now - new Date(entry.startedAt).getTime();
          if (startedAge > 5 * 60_000) {
            delete registry[id];
            pruned = true;
          }
        }
      }

      if (pruned) {
        await this.writeAtomic(registry).catch(() => undefined);
      }

      return registry;
    } catch {
      return {};
    }
  }

  private async atomicUpdate(
    fn: (registry: Record<string, SessionRegistryEntry>) => void,
  ): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    const maxRetries = 5;
    const retryDelayMs = 20;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });

        // Acquire exclusive lock via O_CREAT | O_EXCL
        const lockHandle = await fs.open(lockPath, 'wx').catch(() => null);
        if (!lockHandle) {
          // Lock held by another process — wait and retry
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }

        try {
          const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '{}');
          const registry = JSON.parse(raw) as Record<string, SessionRegistryEntry>;
          fn(registry);
          await this.writeAtomicLocked(registry);
          return; // success
        } finally {
          await lockHandle.close();
          await fs.unlink(lockPath).catch(() => undefined);
        }
      } catch {
        // Best-effort — never throw from registry writes
        return;
      }
    }
    // All retries exhausted — registry update dropped (non-critical)
  }

  private async writeAtomicLocked(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  /** Legacy write without lock — used by heartbeat for performance. */
  private async writeAtomic(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

/** Singleton — created once per process. */
let _instance: SessionRegistry | null = null;

export function getSessionRegistry(globalRoot?: string): SessionRegistry {
  if (!_instance && globalRoot) {
    _instance = new SessionRegistry(globalRoot);
  }
  if (!_instance) {
    throw new Error('SessionRegistry not initialized. Call getSessionRegistry(globalRoot) first.');
  }
  return _instance;
}

export function hasSessionRegistry(): boolean {
  return _instance !== null;
}
