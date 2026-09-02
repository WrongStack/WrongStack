import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DirectorStateCheckpoint } from '../storage/director-state.js';
import type { SubagentConfig } from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import type { FleetUsage } from './fleet-bus.js';
import { FleetBus, FleetUsageAggregator } from './fleet-bus.js';
import type { IFleetManager } from './ifleet-manager.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import { assignNickname, nicknameKeyFromDisplay } from './subagent-nicknames.js';
import type { WorktreeTaskStateUpdate } from './worktree-task-runner.js';
import { resolveMaxSpawnDepth } from './spawn-budget.js';

/** Options for constructing a FleetManager. */
export interface FleetManagerOptions {
  manifestPath?: string | undefined;
  sessionsRoot?: string | undefined;
  directorRunId?: string | undefined;
  maxSpawns?: number | undefined;
  maxSpawnDepth?: number | undefined;
  spawnDepth?: number | undefined;
  stateCheckpointPath?: string | undefined;
  sessionWriter?: SessionWriter | undefined;
  manifestDebounceMs?: number | undefined;
  checkpointDebounceMs?: number | undefined;
  directorBudget?:
    | {
        maxCostUsd?: number | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  /**
   * Maximum context load (as a fraction of maxContext) the leader agent
   * is allowed to reach before a new spawn is rejected. Default: 0.85.
   * When the leader's context pressure exceeds this threshold, spawning
   * a new subagent is refused — the leader must compact first.
   * Set to 1.0 to disable this check.
   */
  maxLeaderContextLoad?: number | undefined;
  /**
   * Provider's max context window in tokens. Used with `maxLeaderContextLoad`
   * to compute the absolute token threshold. Default: 128_000.
   *
   * A function may be supplied when the leader can switch models at runtime;
   * canSpawn() reads it lazily so the spawn threshold follows the active model.
   */
  maxContext?: number | (() => number | undefined) | undefined;
}

/**
 * Fleet-level policy container extracted from `Director`. Owns:
 * - FleetBus + FleetUsageAggregator
 * - Spawn caps and counters
 * - Manifest entries and debounced writing
 * - State checkpointing
 *
 * This lets the `Director` focus on orchestration (spawn/assign/await/ask)
 * while fleet-level decisions live in one place. The class implements
 * `IFleetManager` so it remains swappable in future.
 *
 * @example
 * ```typescript
 * const fm = new FleetManager({ manifestPath: '/tmp/fleet.json' });
 * const err = fm.canSpawn({ name: 'worker' });
 * if (!err) fm.recordSpawn('sub-1', { name: 'worker' });
 * await fm.writeManifest();
 * ```
 */
export class FleetManager implements IFleetManager {
  /** The fleet-wide event bus. */
  readonly fleet: FleetBus;
  /** Usage rollup across all subagents. */
  readonly usage: FleetUsageAggregator;

  private readonly manifestPath?: string | undefined;
  private readonly directorRunId: string;
  /** Spawn cap (lifetime total). Infinity means unlimited. */
  readonly maxSpawns: number;
  /** Nesting cap. */
  readonly maxSpawnDepth: number;
  /** This director's depth in a director chain. Root = 0. */
  readonly spawnDepth: number;
  /** Live spawn counter. */
  private spawnCount = 0;
  /**
   * Historical `maxSpawns` from the last restored checkpoint (set for any
   * finite checkpoint ceiling, matching or not). Surfaced in
   * `budgetSnapshot()` so operators can see resume reconciliation without
   * reading the JSON file; `ceilingMismatch` carries the actual mismatch signal.
   */
  private checkpointMaxSpawnsAtResume: number | undefined;
  private ceilingMismatchAtResume = false;
  private readonly stateCheckpoint: DirectorStateCheckpoint | null;
  private readonly sessionWriter: SessionWriter | null;
  private manifestTimer: NodeJS.Timeout | null = null;
  private manifestWriteChain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /**
   * Teardown freeze. Set by `closeManifest()` after the final manifest is
   * flushed; makes any subsequent `scheduleManifest`/`writeManifest`/
   * `flushManifest` a no-op so a late fire-and-forget write (e.g. the
   * task-completion flush the Director issues via `void flushManifest()`)
   * cannot land an `atomicWrite` in the manifest directory while a caller is
   * deleting it. Cleared by `recordSpawn` so a stop-then-spawn-again host
   * resumes writing.
   */
  private closing = false;
  private readonly manifestDebounceMs: number;
  /** Fleet-wide cost cap. Infinity = no cap. Distinct from SubagentBudget limits,
   *  which track per-subagent spend — this field caps the entire fleet total. */
  private readonly maxFleetCostUsd: number;
  /** Fleet-wide input+output token ceiling. Infinity = no cap. */
  private readonly maxFleetTokens: number;
  private readonly manifestEntries = new Map<
    string,
    {
      subagentId: string;
      name: string;
      role?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      taskIds: string[];
      worktrees?: Record<string, WorktreeTaskStateUpdate> | undefined;
    }
  >();
  /** Pending tasks with their descriptions — populated by `addPendingTask`
   *  and cleared by `removePendingTask`. Replaces the host-side `pending`
   *  Map so task descriptions live in one place (FleetManager). */
  private readonly pendingTasks = new Map<string, { subagentId: string; description: string }>();
  private readonly subagentMeta = new Map<
    string,
    { provider?: string | undefined; model?: string | undefined }
  >();
  private readonly priceLookups = new Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >();
  /** Tracks which nickname keys are already assigned — prevents collisions. */
  private readonly _usedNicknames = new Set<string>();
  /** The coordinator (wired via setCoordinator by Director after construction). */
  private coordinator: DefaultMultiAgentCoordinator | null = null;
  /** Leader agent's current context pressure (full request tokens). */
  private leaderContextPressure = 0;
  /** Maximum context load fraction before spawn is refused. */
  private readonly maxLeaderContextLoad: number;
  /** Provider's max context window in tokens, or a live resolver for runtime model switches. */
  private readonly maxContext: number | (() => number | undefined);

  constructor(opts: FleetManagerOptions = {}) {
    this.manifestPath = opts.manifestPath;
    this.directorRunId = opts.directorRunId ?? randomUUID();
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth = resolveMaxSpawnDepth(opts.maxSpawnDepth);
    this.spawnDepth = opts.spawnDepth ?? 0;
    this.sessionWriter = opts.sessionWriter ?? null;
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxFleetTokens = opts.directorBudget?.maxTokens ?? Number.POSITIVE_INFINITY;
    this.maxLeaderContextLoad = opts.maxLeaderContextLoad ?? 0.85;
    this.maxContext = opts.maxContext ?? 128_000;
    this.stateCheckpoint = opts.stateCheckpointPath
      ? new DirectorStateCheckpoint(
          opts.stateCheckpointPath,
          {
            directorRunId: this.directorRunId,
            maxSpawns: opts.maxSpawns,
            spawnDepth: this.spawnDepth,
            maxSpawnDepth: this.maxSpawnDepth,
            directorBudget: opts.directorBudget,
          },
          opts.checkpointDebounceMs ?? 250,
        )
      : null;

    this.fleet = new FleetBus();
    this.usage = new FleetUsageAggregator(
      this.fleet,
      (_id, provider, model) => {
        if (provider && model) return this.priceLookups.get(`${provider}/${model}`);
        return undefined;
      },
      (id) => this.subagentMeta.get(id),
    );
  }

  // -----------------------------------------------------------------------
  // IFleetManager surface
  // -----------------------------------------------------------------------

  get fleetBus(): FleetBus {
    return this.fleet;
  }

  /**
   * Wire the coordinator after Director construction. The coordinator
   * is not available when FleetManager is constructed standalone.
   * Once set, `getFleetStats()` delegates to `coordinator.getStats()`.
   */
  setCoordinator(coordinator: DefaultMultiAgentCoordinator): void {
    this.coordinator = coordinator;
  }

  snapshot(): FleetUsage {
    return this.usage.snapshot();
  }

  getSubagentMeta(
    id: string,
  ):
    | { provider?: string | undefined; model?: string | undefined; name?: string | undefined }
    | undefined {
    const meta = this.subagentMeta.get(id);
    const manifest = this.manifestEntries.get(id);
    if (!meta && !manifest) return undefined;
    return {
      provider: meta?.provider ?? manifest?.provider,
      model: meta?.model ?? manifest?.model,
      name: manifest?.name,
    };
  }

  /**
   * Returns null if the spawn is allowed, or an object describing
   * which cap was exceeded. Does NOT throw — the caller decides
   * how to surface the rejection.
   */
  canSpawn(config: SubagentConfig): {
    kind: 'max_spawns' | 'max_spawn_depth' | 'max_cost_usd' | 'max_tokens' | 'max_context_load';
    limit: number;
    observed: number;
  } | null {
    if (this.spawnDepth >= this.maxSpawnDepth) {
      return { kind: 'max_spawn_depth', limit: this.maxSpawnDepth, observed: this.spawnDepth };
    }
    // Budget-exempt spawns (Chimera reviewers, cascade agents) bypass the
    // lifetime spawn cap — background review traffic must not be able to
    // brick the leader's own delegation budget, and vice versa.
    if (!config.spawnBudgetExempt && this.spawnCount >= this.maxSpawns) {
      return { kind: 'max_spawns', limit: this.maxSpawns, observed: this.spawnCount + 1 };
    }
    if (this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
      const totalCost = this.usage.snapshot().total?.cost ?? 0;
      if (totalCost >= this.maxFleetCostUsd) {
        return { kind: 'max_cost_usd', limit: this.maxFleetCostUsd, observed: totalCost };
      }
    }
    if (this.maxFleetTokens < Number.POSITIVE_INFINITY) {
      const total = this.usage.snapshot().total;
      const usedTokens = (total?.input ?? 0) + (total?.output ?? 0);
      if (usedTokens >= this.maxFleetTokens) {
        return { kind: 'max_tokens', limit: this.maxFleetTokens, observed: usedTokens };
      }
    }
    // Context pressure check: reject spawn if leader context is too full.
    // maxLeaderContextLoad === 1.0 disables this check.
    if (this.maxLeaderContextLoad < 1.0) {
      const maxContext = this.resolveMaxContext();
      const threshold = maxContext * this.maxLeaderContextLoad;
      if (this.leaderContextPressure >= threshold) {
        return {
          kind: 'max_context_load',
          limit: threshold,
          observed: this.leaderContextPressure,
        };
      }
    }
    return null;
  }

  budgetSnapshot(): {
    maxSpawns: number;
    usedSpawns: number;
    remainingSpawns: number;
    maxTokens: number;
    usedTokens: number;
    remainingTokens: number;
    maxCostUsd: number;
    usedCostUsd: number;
    remainingCostUsd: number;
    /** Historical ceiling from the last restored checkpoint, when it differs. */
    checkpointMaxSpawns?: number | undefined;
    /** True when checkpoint metadata and the live ceiling disagree. */
    ceilingMismatch?: boolean | undefined;
  } {
    const total = this.usage.snapshot().total;
    const usedTokens = (total?.input ?? 0) + (total?.output ?? 0);
    const usedCostUsd = total?.cost ?? 0;
    return {
      maxSpawns: this.maxSpawns,
      usedSpawns: this.spawnCount,
      remainingSpawns: Math.max(0, this.maxSpawns - this.spawnCount),
      maxTokens: this.maxFleetTokens,
      usedTokens,
      remainingTokens: Math.max(0, this.maxFleetTokens - usedTokens),
      maxCostUsd: this.maxFleetCostUsd,
      usedCostUsd,
      remainingCostUsd: Math.max(0, this.maxFleetCostUsd - usedCostUsd),
      ...(this.checkpointMaxSpawnsAtResume !== undefined
        ? { checkpointMaxSpawns: this.checkpointMaxSpawnsAtResume }
        : {}),
      ...(this.ceilingMismatchAtResume ? { ceilingMismatch: true } : {}),
    };
  }

  /**
   * Re-attach the on-disk checkpoint after a resume while keeping the live
   * `maxSpawns` ceiling from construction (profile / flag / env). The
   * historical `spawnCount` is deliberately NOT restored: the lifetime
   * budget is scoped to this director run, so a restarted session gets a
   * fresh budget instead of inheriting a (possibly exhausted) counter from
   * before the restart. The checkpoint ceiling is rewritten to the live
   * value so subsequent writes do not reintroduce a stale limit.
   */
  restoreFromCheckpoint(snapshot: {
    spawnCount: number;
    maxSpawns?: number | undefined;
    version?: 1 | undefined;
    directorRunId?: string | undefined;
    updatedAt?: string | undefined;
    spawnDepth?: number | undefined;
    maxSpawnDepth?: number | undefined;
    directorBudget?:
      | {
          maxCostUsd?: number | undefined;
          maxTokens?: number | undefined;
        }
      | undefined;
    subagents?: unknown[] | undefined;
    tasks?: unknown[] | undefined;
    usage?: unknown | undefined;
  }): {
    usedSpawns: number;
    maxSpawns: number;
    remainingSpawns: number;
    checkpointMaxSpawns?: number | undefined;
    ceilingMismatch: boolean;
  } {
    // NOTE: snapshot.spawnCount is intentionally ignored — see the docblock.
    // The lifetime budget restarts with this director run.
    const checkpointMax =
      typeof snapshot.maxSpawns === 'number' && Number.isFinite(snapshot.maxSpawns)
        ? snapshot.maxSpawns
        : undefined;
    // A stored finite cap resumed under a live Infinity ceiling IS a
    // mismatch — the isFinite conjunct previously hid exactly the
    // reconciliation case this flag exists to surface.
    const ceilingMismatch = checkpointMax !== undefined && checkpointMax !== this.maxSpawns;

    this.checkpointMaxSpawnsAtResume = checkpointMax;
    this.ceilingMismatchAtResume = ceilingMismatch;

    if (this.stateCheckpoint) {
      // Full snapshot re-attach when possible; otherwise only counters matter.
      if (snapshot.version === 1 && snapshot.directorRunId && snapshot.updatedAt) {
        this.stateCheckpoint.resume(
          snapshot as import('../storage/director-state.js').DirectorStateSnapshot,
        );
        this.stateCheckpoint.reconcileCrashedState();
      }
      this.stateCheckpoint.applyLiveMaxSpawns(
        Number.isFinite(this.maxSpawns) ? this.maxSpawns : undefined,
      );
    }

    return {
      usedSpawns: this.spawnCount,
      maxSpawns: this.maxSpawns,
      remainingSpawns: Math.max(0, this.maxSpawns - this.spawnCount),
      ...(checkpointMax !== undefined ? { checkpointMaxSpawns: checkpointMax } : {}),
      ceilingMismatch,
    };
  }

  setLeaderContextPressure(tokens: number): void {
    this.leaderContextPressure = tokens;
  }

  /** Test-only accessor: number of entries in the private subagent-meta map. */
  getSubagentMetaSizeForTests(): number {
    return this.subagentMeta.size;
  }

  /** Test-only accessor: number of entries in the private price-lookup map. */
  getPriceLookupsSizeForTests(): number {
    return this.priceLookups.size;
  }

  /** Test-only accessor: check whether a private price-lookup key is present. */
  hasPriceLookupForTests(key: string): boolean {
    return this.priceLookups.has(key);
  }

  /** Test-only accessor: check whether a private subagent-meta key is present. */
  hasSubagentMetaForTests(key: string): boolean {
    return this.subagentMeta.has(key);
  }

  private resolveMaxContext(): number {
    const resolved = typeof this.maxContext === 'function' ? this.maxContext() : this.maxContext;
    return resolved && resolved > 0 ? resolved : 128_000;
  }

  /**
   * Assign a memorable nickname (e.g. "Einstein (Bug Hunter)") to the config,
   * record it so the same name is never reused, then record the spawn.
   *
   * Call this INSTEAD of `recordSpawn` when you want automatic nicknames.
   * The nickname is written back to `config.name` BEFORE the coordinator
   * sees the config, so the manifest, logs, and fleet UI all show it.
   *
   * NOTE: This method ONLY assigns the nickname and marks it used.
   * The caller MUST call `recordSpawn(subagentId, config, priceLookup)` AFTER
   * `coordinator.spawn()` returns with the real subagentId. This is because
   * the subagentId is not known until after the coordinator creates the subagent.
   */
  assignNicknameAndRecord(config: SubagentConfig): string {
    const role = config.role ?? 'subagent';
    const { key, display } = assignNickname(role, this._usedNicknames);
    // Mark the canonical pool key used so the same name is never reused.
    this._usedNicknames.add(key);
    // Write the full nickname back into config so the coordinator
    // and manifest both see the human name.
    config.name = display;
    return display;
  }

  /**
   * Returns the set of already-assigned nickname keys — useful for debugging
   * and testing.
   */
  get usedNicknames(): ReadonlySet<string> {
    return this._usedNicknames;
  }

  /**
   * Records a spawn: stores metadata, updates state checkpoint, and schedules
   * a debounced manifest write. Increments the lifetime spawn counter UNLESS
   * the config is `spawnBudgetExempt` (ephemeral Chimera reviewer/cascade
   * spawns do not consume the leader's budget). Call AFTER the coordinator
   * has successfully spawned the subagent.
   *
   * @param subagentId The subagent's id (from coordinator.spawn result)
   * @param config The SubagentConfig that was used
   * @param priceLookup Optional per-subagent pricing data
   */
  recordSpawn(
    subagentId: string,
    config: SubagentConfig,
    priceLookup?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    },
  ): void {
    // New fleet activity after a stop lifts the teardown freeze so manifest
    // writes resume.
    this.closing = false;
    // Budget-exempt spawns (Chimera reviewers, cascade agents) do not consume
    // the leader's lifetime spawn budget — the counter stays leader-only.
    if (!config.spawnBudgetExempt) {
      this.spawnCount += 1;
    }
    this.subagentMeta.set(subagentId, {
      provider: config.provider,
      model: config.model,
    });
    if (priceLookup && config.provider && config.model) {
      this.priceLookups.set(`${config.provider}/${config.model}`, priceLookup);
    }
    this.manifestEntries.set(subagentId, {
      subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      taskIds: [],
    });
    // State checkpoint: persist the spawn even before any task is assigned
    this.stateCheckpoint?.recordSpawn(
      {
        id: subagentId,
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
        spawnedAt: new Date().toISOString(),
      },
      this.spawnCount,
    );
    void this.appendSessionEvent({
      type: 'agent_spawned',
      ts: new Date().toISOString(),
      agentId: subagentId,
      role: config.role ?? config.name,
    });
    this.scheduleManifest();
  }

  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    // Frozen for teardown — refuse to start a new write. The final manifest
    // was already flushed by `closeManifest()`; a late caller just gets the
    // path back so it isn't mistaken for an unconfigured manager.
    if (this.closing) return this.manifestPath;
    this.clearManifestTimer();
    const write = this.manifestWriteChain
      .catch(() => undefined)
      .then(() => this.writeManifestNow());
    this.manifestWriteChain = write.catch(() => undefined);
    return write;
  }

  private async writeManifestNow(): Promise<string | null> {
    if (!this.manifestPath) return null;
    const manifest = {
      version: 1,
      directorRunId: this.directorRunId,
      generatedAt: new Date().toISOString(),
      children: Array.from(this.manifestEntries.values()).map((entry) => ({
        id: entry.subagentId,
        name: entry.name,
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        taskIds: entry.taskIds,
        worktrees: entry.worktrees,
      })),
      usage: this.usage.snapshot(),
    };
    await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
    await atomicWrite(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return this.manifestPath;
  }

  /**
   * Attach task ids to an already-spawned subagent. Called by
   * `Director.assign()` after the coordinator assigns a task.
   */
  addTaskToSubagent(subagentId: string, taskId: string): void {
    const entry = this.manifestEntries.get(subagentId);
    if (entry) entry.taskIds.push(taskId);
  }

  recordTaskWorktree(update: WorktreeTaskStateUpdate): void {
    const entry = this.manifestEntries.get(update.subagentId);
    if (entry) {
      entry.worktrees = { ...(entry.worktrees ?? {}), [update.taskId]: update };
    }
    this.stateCheckpoint?.recordTaskWorktree(update.taskId, update);
    this.scheduleManifest();
  }

  /**
   * Debounced manifest write. Call after any state mutation
   * (spawn, assign, complete) so a burst collapses into one write.
   * When `manifestDebounceMs` is 0, writes are synchronous (no debounce).
   */
  scheduleManifest(): void {
    if (this.disposed || this.closing) return;
    if (!this.manifestPath) return;
    if (this.manifestDebounceMs === 0) {
      // 0 means instant flush — write synchronously, no timer.
      void this.writeManifest().catch((err) => {
        const detail = toErrorMessage(err);
        process.emitWarning(`FleetManager manifest write failed: ${detail}`, 'FleetManagerWarning');
      });
      return;
    }
    if (this.manifestDebounceMs < 0) return;
    if (this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.writeManifest().catch((err) => {
        // Surface via process.emitWarning so a persistent manifest-write
        // failure doesn't get silently swallowed (e.g. ENOSPC on the
        // sessions dir would otherwise leave fleet state un-persisted with
        // no signal until shutdown).
        const detail = toErrorMessage(err);
        process.emitWarning(`FleetManager manifest write failed: ${detail}`, 'FleetManagerWarning');
      });
    }, this.manifestDebounceMs);
  }

  /**
   * Bypass the debounce timer and write the manifest immediately.
   * Clears any pending debounce timer before writing.
   */
  async flushManifest(): Promise<void> {
    if (!this.manifestPath) return;
    this.clearManifestTimer();
    await this.writeManifest().catch((err) => {
      const detail = toErrorMessage(err);
      process.emitWarning(`FleetManager manifest write failed: ${detail}`, 'FleetManagerWarning');
    });
  }

  /**
   * Teardown flush for callers that will delete the manifest directory next
   * (host `stopAll`/`dispose`). Writes the final manifest, then freezes the
   * writer so no later fire-and-forget write can start, and drains anything
   * still in flight. After this resolves it is safe to `rm -rf` the manifest
   * directory: no `atomicWrite` (temp sibling + rename) can race the removal.
   *
   * The freeze is lifted by the next `recordSpawn`, so a stop-then-spawn-again
   * host keeps persisting manifests.
   */
  async closeManifest(): Promise<void> {
    if (!this.manifestPath) return;
    // Final canonical write, fully awaited, while writes are still allowed.
    await this.flushManifest();
    // Freeze: subsequent schedule/write/flush become no-ops (see guards).
    this.closing = true;
    // Drain any write that slipped into the chain between the flush above and
    // the freeze (e.g. a task-completion `void flushManifest()` racing in).
    await this.manifestWriteChain.catch(() => undefined);
  }

  private clearManifestTimer(): void {
    if (!this.manifestTimer) return;
    clearTimeout(this.manifestTimer);
    this.manifestTimer = null;
  }

  /** Best-effort session event writer. Swallows failures. */
  private async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    if (!this.sessionWriter) return;
    try {
      await this.sessionWriter.append(event);
    } catch {
      // ignore
    }
  }

  // -----------------------------------------------------------------------
  // Pending task management — eliminates host-side state duplication
  // -----------------------------------------------------------------------

  addPendingTask(taskId: string, subagentId: string, description: string): void {
    this.pendingTasks.set(taskId, { subagentId, description });
  }

  removePendingTask(taskId: string): void {
    this.pendingTasks.delete(taskId);
  }

  getFleetStats(): {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    subagentStatuses: { subagentId: string; taskId: string; status: string; assigned: boolean }[];
  } {
    if (!this.coordinator) {
      return {
        total: 0,
        running: 0,
        idle: 0,
        stopped: 0,
        inFlight: 0,
        pending: 0,
        completed: 0,
        subagentStatuses: [],
      };
    }
    const stats = this.coordinator.getStats();
    const subagentStatuses: {
      subagentId: string;
      taskId: string;
      status: string;
      assigned: boolean;
    }[] = [];
    for (const [subagentId, s] of this.coordinator['subagents']) {
      subagentStatuses.push({
        subagentId,
        taskId: s.currentTask ?? '',
        status: s.status,
        assigned: s.context.parentBridge !== null,
      });
    }
    return { ...stats, subagentStatuses };
  }

  getFleetStatus(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    live: { subagentId: string; status: string; task?: string | undefined }[];
  } {
    const pending = Array.from(this.pendingTasks.entries()).map(([taskId, v]) => ({
      taskId,
      description: v.description,
      subagentId: v.subagentId,
    }));
    // live is populated by MultiAgentHost from the coordinator — fleet
    // manager has no direct visibility into subagent status
    return { pending, live: [] };
  }

  /**
   * Clean up all fleet-manager state associated with a removed subagent:
   * - Frees the nickname slot so the same name can be reused
   * - Removes any pending tasks for this subagent
   * - Drops the manifest / meta / price-lookup entries (these previously leaked:
   *   they were never deleted, so each grew one entry per subagent — and each
   *   manifest entry's `taskIds[]` one per task — for the whole leader lifetime).
   */
  removeSubagent(subagentId: string): void {
    // Free the nickname slot so the same name can be reused.
    const entry = this.manifestEntries.get(subagentId);
    if (entry?.name) {
      const nicknameKey = nicknameKeyFromDisplay(entry.name);
      if (nicknameKey) this._usedNicknames.delete(nicknameKey);
    }
    // Remove any pending tasks assigned to this subagent.
    for (const [taskId, task] of this.pendingTasks) {
      if (task.subagentId === subagentId) {
        this.pendingTasks.delete(taskId);
      }
    }
    // Drop the per-subagent metadata maps — the removal is the point at which
    // this subagent's manifest/meta/price-lookup are no longer needed.
    //
    // priceLookups is keyed by `${provider}/${model}` (shared across subagents
    // using the same model), NOT by subagentId. Read provider/model from
    // subagentMeta FIRST, then delete the price-lookup entry, then drop the
    // meta entry — order is critical because Map.delete is a no-op on a
    // missing key. Previously this deleted `subagentId` from priceLookups,
    // which never matched any real key, so every retired subagent leaked its
    // price-lookup entry for the lifetime of the leader process.
    this.manifestEntries.delete(subagentId);
    const meta = this.subagentMeta.get(subagentId);
    if (meta?.provider && meta.model) {
      this.priceLookups.delete(`${meta.provider}/${meta.model}`);
    }
    this.subagentMeta.delete(subagentId);
  }

  /** Release all resources: clear the manifest debounce timer and dispose the usage aggregator. */
  dispose(): void {
    this.disposed = true;
    this.clearManifestTimer();
    this.usage.dispose();
  }
}
