/**
 * Collaborative Debugging Session — parallel multi-agent debugging on the same problem.
 *
 * Architecture:
 * - BugHunter, RefactorPlanner, and Critic run in parallel on shared file snapshots.
 * - Findings flow through the FleetBus via structured events: bug.found → refactor.plan → critic.evaluation.
 * - The Director acts as ResultRouter, collecting outputs and routing them to dependents.
 * - A shared scratchpad stores intermediate results so agents can read each other's
 *   conclusions without needing each other's full transcripts.
 *
 * Flow:
 *   1. Director.spawnCollab() creates a CollabSession with a SharedFileSnapshot.
 *   2. All three agents are spawned simultaneously and receive the same file snapshot.
 *   3. BugHunter emits bug.found events → Director routes to RefactorPlanner.
 *   4. RefactorPlanner subscribes to bug.found and emits refactor.plan events.
 *   5. Critic subscribes to both bug.found and refactor.plan and emits critic.evaluation.
 *   6. Director collects all results and produces a structured CollabDebugReport.
 *
 * Timeout and cancellation:
 *   - CollabSession agents report budget threshold events to the Director via fleet events.
 *   - The Director's collabAlert() handler receives warnings for timeout/iteration/tool_call
 *     thresholds and can decide to cancel the session or let it continue.
 *   - Director.cancelCollabSession() sends director.cancel_collab to all collab agents,
 *     causing them to finish early with a 'cancelled' status in the report.
 *   - The Director reads /btw notes via getLeaderBtwNotes() and can inject them into
 *     collab agents via task context before making cancellation decisions.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import { expandGlob } from '../utils/glob-expand.js';
import type { CollabDirectorHost } from './collab-director-host.js';
import { validateFleetEventEmission } from './fleet-event-validation.js';

/**
 * Default maximum number of files a collab_debug session may target.
 * Each of the three agents (BugHunter, RefactorPlanner, Critic) receives
 * the full file snapshot as context — a large target causes token overflow
 * and timeout failures. Keep this low (20-30) for reliable sessions.
 * Used when neither `maxTargetFiles` nor `contextWindow` is provided.
 */
export const DEFAULT_MAX_TARGET_FILES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Alert levels the Director can emit when a collab session needs attention.
 * These flow through the FleetBus so the host can display them in the UI.
 */
export enum DirectorAlertLevel {
  /** The agent is still making progress but has hit a soft budget limit. */
  WARNING = 'warning',
  /** The agent has hit a hard limit and the session cannot continue. */
  CRITICAL = 'critical',
  /** The Director has decided to cancel the session (user request or policy). */
  CANCELLED = 'cancelled',
}

export interface DirectorAlert {
  sessionId: string;
  subagentId: string;
  role: string;
  level: DirectorAlertLevel;
  /** Human-readable message for UI/logs */
  message: string;
  /** Budget kind that triggered this alert, if any */
  budgetKind?:
    | 'timeout'
    | 'idle_timeout'
    | 'iterations'
    | 'tool_calls'
    | 'tokens'
    | 'cost'
    | undefined;
  /** Elapsed ms at time of alert */
  elapsedMs?: number | undefined;
  /** Limit that was hit */
  limit?: number | undefined;
  /** /btw notes the director has collected (may be empty) */
  btwNotes?: string[] | undefined;
}

/**
 * Immutable snapshot of target files at the start of a collab session.
 * All agents in the session read from this snapshot — they see the same baseline.
 */
export interface SharedFileSnapshot {
  id: string;
  createdAt: string;
  files: SharedFileEntry[];
}

export interface SharedFileEntry {
  path: string;
  content: string;
  language?: string | undefined;
  snapshotMtimeMs?: number | undefined;
  snapshotSizeBytes?: number | undefined;
}

/**
 * Bug finding emitted by BugHunter and consumed by RefactorPlanner + Critic.
 */
export interface BugFinding {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: { file: string; line: number };
  description: string;
  suggestedFix?: string | undefined;
}

/**
 * Refactoring plan emitted by RefactorPlanner, consuming BugFinding(s).
 */
export interface RefactorPlan {
  id: string;
  basedOnBugIds: string[];
  phases: RefactorPhase[];
  riskScore: 'low' | 'medium' | 'high';
  estimatedChangeCount: number;
  rollbackStrategy: string;
}

/** One phase within a refactor plan. */
export interface RefactorPhase {
  number: number;
  title: string;
  tasks: string[];
  risk: 'low' | 'medium' | 'high';
}

/**
 * Critic evaluation of a bug finding or refactor plan.
 */
export interface CriticEvaluation {
  id: string;
  subjectType: 'bug_finding' | 'refactor_plan';
  subjectId: string;
  score: number; // 0-10
  verdict: 'approve' | 'needs_revision' | 'reject';
  strengths: string[];
  weaknesses: string[];
  concerns: CriticConcern[];
}

export interface CriticConcern {
  description: string;
  location?: { file: string | undefined; line: number };
  severity: 'blocking' | 'advisory';
}

/**
 * Full structured report produced when a CollabSession resolves.
 */
export interface CollabDebugReport {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  targetPaths: string[];
  /** How the session ended. 'completed' = all agents finished normally.
   * 'cancelled' = Director called cancelCollabSession().
   * 'timeout' = session-level timeout elapsed before all agents finished.
   * 'critical_alert' = Director escalated a warning to a cancel decision.
   */
  disposition: 'completed' | 'cancelled' | 'timeout' | 'critical_alert';
  bugs: BugFinding[];
  refactorPlans: RefactorPlan[];
  evaluations: CriticEvaluation[];
  /** Alerts that were raised during the session (may be empty). */
  alerts: DirectorAlert[];
  /** Files modified after the initial static snapshot was captured. */
  snapshotWarnings?: string[] | undefined;
  /** Overall verdict from the Critic across all evaluated subjects. */
  overallVerdict: 'approve' | 'needs_revision' | 'reject';
  /** Markdown-formatted summary for the director's context window. */
  summary: string;
}

/**
 * Per-agent budget configuration for collab sessions.
 * Allows the caller (Director) to control the exact limits instead of
 * using hard-coded defaults that may not match the director's policy.
 */
export interface CollabBudgetConfig {
  maxIterations: number;
  maxToolCalls: number;
  timeoutMs: number;
}

/**
 * Budget overrides for specific roles in a collab session.
 * When a role is not present in the map, the default budget is used.
 */
export type CollabBudgetOverrides = Partial<Record<string, CollabBudgetConfig>>;

// ---------------------------------------------------------------------------
// Event payload types (what gets put on the FleetBus)
// ---------------------------------------------------------------------------

interface BugFoundPayload {
  finding: BugFinding;
}

interface RefactorPlanPayload {
  plan: RefactorPlan;
}

interface CriticEvaluationPayload {
  evaluation: CriticEvaluation;
}

/**
 * Emitted by a collab agent when it hits a soft budget limit.
 * The Director's fleet handler receives this and calls collabAlert().
 */
export interface CollabBudgetWarningPayload {
  sessionId: string;
  role: string;
  kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
  used: number;
  limit: number;
  timeoutMs?: number | undefined;
  elapsedMs: number;
}

/**
 * Emitted by the Director to cancel all agents in a collab session.
 * CollabSession listens for this and causes its agent pool to finish early.
 */
export interface DirectorCancelCollabPayload {
  sessionId: string;
  reason: string;
  cancelledAt: string;
}

// ---------------------------------------------------------------------------
// CollabSessionOptions — extends base with budget + alert callbacks
// ---------------------------------------------------------------------------

export interface CollabSessionOptions {
  /** Paths to scan — used to build the SharedFileSnapshot. */
  targetPaths: string[];
  /** Files already read and snapshot. When provided, snapshot is skipped. */
  prebuiltSnapshot?: SharedFileSnapshot | undefined;
  /** Max time to wait for the session to resolve (ms). Default: 10 min. */
  timeoutMs?: number | undefined;
  /**
   * Maximum number of files to include in the snapshot.
   * - If set explicitly: use this value (hard override).
   * - If `contextWindow` is set: calculate dynamically from estimated token budget.
   * - If neither: use `DEFAULT_MAX_TARGET_FILES` (30).
   */
  maxTargetFiles?: number | undefined;
  /**
   * Context window size (in tokens) of the model running the subagents.
   * When provided and `maxTargetFiles` is not set, the limit is computed
   * dynamically: `floor((contextWindow * 0.4) / AVG_TOKENS_PER_FILE)`.
   * If not provided, `DEFAULT_MAX_TARGET_FILES` is used as the fallback.
   */
  contextWindow?: number | undefined;
  /**
   * Budget overrides per role. When provided, these override the hard-coded
   * defaults so the Director can enforce fleet-wide budget policy.
   * Keys must match role names: 'bug-hunter', 'refactor-planner', 'critic'.
   */
  budgetOverrides?: CollabBudgetOverrides | undefined;
  /**
   * Called by the Director when a collab agent hits a soft budget limit.
   * The Director uses this to decide whether to cancel the session or extend.
   * Return 'cancel' to stop the session immediately; 'extend' to continue
   * with the agent's proposed new limits; 'ignore' to let the default
   * auto-extend logic handle it.
   */
  onBudgetWarning?: ((alert: DirectorAlert) => 'cancel' | 'extend' | 'ignore') | undefined;
}

// ---------------------------------------------------------------------------
// CollabSession — coordinates the three-agent pipeline
// ---------------------------------------------------------------------------

export class CollabSession extends EventEmitter {
  readonly sessionId: string;
  readonly options: CollabSessionOptions;
  readonly snapshot: SharedFileSnapshot;

  private readonly director: CollabDirectorHost;
  private readonly fleetBus: import('./fleet-bus.js').FleetBus;
  private readonly subagentIds = new Map<string, string>(); // role → subagentId
  private readonly bugs = new Map<string, BugFinding>();
  private readonly plans = new Map<string, RefactorPlan>();
  private readonly evaluations = new Map<string, CriticEvaluation>();
  private readonly disposers = [] as (() => void)[];
  private settled = false;
  private readonly timeoutMs: number;
  private cancelled = false;
  private _raceResolved = false;
  private readonly alerts: DirectorAlert[] = [];
  private snapshotWarnings: string[] = [];

  /** Tracks tool call counts per subagent for progress-based timeout decisions. */
  private readonly progressBySubagent = new Map<string, number>();
  /** Last tool call count when a timeout warning was handled. */
  private readonly lastTimeoutProgress = new Map<string, number>();
  /** Session-level timeout timer handle (cleared on cancel or natural completion). */
  private _timeoutTimer?: NodeJS.Timeout | undefined;

  constructor(
    director: CollabDirectorHost,
    fleetBus: import('./fleet-bus.js').FleetBus,
    options: CollabSessionOptions,
  ) {
    super();
    this.sessionId = randomUUID();
    this.options = options;
    this.director = director;
    this.fleetBus = fleetBus;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

    if (options.prebuiltSnapshot) {
      this.snapshot = options.prebuiltSnapshot;
    } else {
      this.snapshot = {
        id: this.sessionId,
        createdAt: new Date().toISOString(),
        files: [],
      };
    }
  }

  get id(): string {
    return this.sessionId;
  }

  getSessionAlerts(): DirectorAlert[] {
    return [...this.alerts];
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Snapshot of role → subagentId map. The Director calls coordinator.stop()
   * for each agent when cancelling the session, using this map to enumerate
   * all three collab agents.
   */
  getSubagentIds(): ReadonlyMap<string, string> {
    return new Map(this.subagentIds);
  }

  /**
   * Returns the effective file limit for this session.
   * Priority: explicit `maxTargetFiles` > dynamic from `contextWindow` > `DEFAULT_MAX_TARGET_FILES`.
   */
  effectiveFileLimit(): number {
    if (this.options.maxTargetFiles !== undefined) {
      return this.options.maxTargetFiles;
    }
    if (this.options.contextWindow !== undefined) {
      // Reserve 40% of context window for the file snapshot.
      // Heuristic: ~2000 tokens per average source file.
      return Math.max(5, Math.floor((this.options.contextWindow * 0.4) / 2000));
    }
    return DEFAULT_MAX_TARGET_FILES;
  }

  async buildSnapshot(): Promise<SharedFileSnapshot> {
    if (this.snapshot.files.length > 0) return this.snapshot;
    const allFiles: string[] = [];
    for (const pattern of this.options.targetPaths) {
      const expanded = await expandGlob(pattern);
      allFiles.push(...expanded);
    }
    const limit = this.effectiveFileLimit();
    if (allFiles.length > limit) {
      const hint = this.options.contextWindow
        ? `contextWindow=${this.options.contextWindow} → calculated limit=${limit}`
        : `default limit=${DEFAULT_MAX_TARGET_FILES}`;
      throw new Error(
        `[collab_debug] Target has ${allFiles.length} files, which exceeds the ` +
          `limit (${hint}). Narrow the target or pass maxTargetFiles / contextWindow ` +
          `to override. For large codebases, run package-by-package or ` +
          `module-by-module sessions instead of targeting the entire repo.`,
      );
    }
    for (const filePath of allFiles) {
      try {
        const [content, stat] = await Promise.all([
          fsp.readFile(filePath, 'utf8'),
          fsp.stat(filePath),
        ]);
        const ext = filePath.split('.').pop() ?? '';
        const language =
          ext === 'ts' || ext === 'tsx'
            ? 'typescript'
            : ext === 'js' || ext === 'jsx'
              ? 'javascript'
              : ext === 'md'
                ? 'markdown'
                : ext === 'json'
                  ? 'json'
                  : undefined;
        this.snapshot.files.push({
          path: filePath,
          content,
          language,
          snapshotMtimeMs: stat.mtimeMs,
          snapshotSizeBytes: stat.size,
        });
      } catch {
        this.snapshot.files.push({ path: filePath, content: '', language: undefined });
      }
    }
    return this.snapshot;
  }

  /**
   * Cancel the session. Emits director.cancel_collab on the FleetBus so all
   * collab agents finish early. The session-level timeout timer is also cleared.
   * Safe to call multiple times (idempotent after first call).
   */
  cancel(reason = 'Director cancelled collab session'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    this.fleetBus.emit({
      subagentId: this.director.id,
      ts: Date.now(),
      type: 'director.cancel_collab',
      payload: {
        sessionId: this.sessionId,
        reason,
        cancelledAt: new Date().toISOString(),
      } as DirectorCancelCollabPayload,
    });
    this.fleetBus.emit({
      subagentId: this.director.id,
      ts: Date.now(),
      type: 'collab.cancelled',
      payload: { sessionId: this.sessionId, reason },
    });
  }

  async start(): Promise<CollabDebugReport> {
    if (this.settled) throw new Error('session already settled');
    this.settled = true;

    await this.buildSnapshot();
    this.wireFleetBus();

    // spawnAgent can fail (spawn cap, context overflow, assign rejection).
    // wireFleetBus() already registered 6 FleetBus subscriptions into
    // this.disposers — a throw here would bypass both cleanup() call sites
    // below and leak those listeners onto the shared FleetBus for the
    // Director's lifetime. Catch, clean up, emit session.error so the
    // controller can stop any already-spawned agents, and rethrow.
    //
    // spawnAgent records each successfully-spawned agent into subagentIds
    // immediately after spawn returns, before assign — so a partial failure
    // (one sibling throws after another spawned) still surfaces the orphan
    // via getSubagentIds(). The controller's session.error handler stops it.
    let bugHunter: { subagentId: string; taskId: string };
    let refactorPlanner: { subagentId: string; taskId: string };
    let critic: { subagentId: string; taskId: string };
    try {
      [bugHunter, refactorPlanner, critic] = await Promise.all([
        this.spawnAgent('bug-hunter', this.buildBugHunterTask()),
        this.spawnAgent('refactor-planner', this.buildRefactorPlannerTask()),
        this.spawnAgent('critic', this.buildCriticTask()),
      ]);
    } catch (err) {
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session.error', error);
      throw error;
    }

    this.subagentIds.set('bug-hunter', bugHunter.subagentId);
    this.subagentIds.set('refactor-planner', refactorPlanner.subagentId);
    this.subagentIds.set('critic', critic.subagentId);

    const timeout = new Promise<never>((_, reject) => {
      this._timeoutTimer = setTimeout(() => {
        if (this._raceResolved) return;
        this.cancel('Session-level timeout reached');
        reject(new Error(`CollabSession timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    let results: TaskResult[][] | null = null;
    try {
      results = await Promise.race([
        Promise.all([
          this.director.awaitTasks([bugHunter.taskId]),
          this.director.awaitTasks([refactorPlanner.taskId]),
          this.director.awaitTasks([critic.taskId]),
        ]),
        timeout,
      ]);
    } catch (err) {
      // Promise.race rejected — either the timeout fired or one of the
      // awaitTasks failed. In both cases `results` is unassigned. Clear the
      // timer if the timeout won the race, always clean up, then re-throw.
      // NOTE: we cannot distinguish timeout from awaitTasks failure here
      // without additional state. Both are treated as session failure.
      this._raceResolved = true;
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = undefined;
      }
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session.error', error);
      throw error;
    }

    // If we are here, Promise.race resolved (not rejected) — results were assigned.
    // Guard with non-null assertion since TypeScript doesn't know the try/catch
    // guarantees this when we reach this line.
    for (const result of results?.flat() ?? []) {
      await this.parseAndEmit(result);
    }

    this.snapshotWarnings = await this.checkSnapshotFreshness();
    const report = this.assembleReport();
    this._raceResolved = true;
    this.cleanup();
    this.emit('session.done', report);
    return report;
  }

  private async parseAndEmit(result: TaskResult): Promise<void> {
    if (result.status !== 'success' || result.result == null) return;
    const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

    for (const obj of this.extractJsonObjects(text)) {
      const type =
        'finding' in obj
          ? 'bug.found'
          : 'plan' in obj
            ? 'refactor.plan'
            : 'evaluation' in obj
              ? 'critic.evaluation'
              : null;
      if (!type) continue;
      const validationError = validateFleetEventEmission(
        type,
        obj,
        this.roleFromSubagentId(result.subagentId) ?? undefined,
      );
      if (validationError) continue;
      this.fleetBus.emit({
        subagentId: result.subagentId,
        taskId: result.taskId,
        ts: Date.now(),
        type,
        payload: obj,
      });
    }
  }

  private extractJsonObjects(text: string): Array<Record<string, unknown>> {
    const objects: Array<Record<string, unknown>> = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              objects.push(parsed as Record<string, unknown>);
            }
          } catch {
            // skip malformed span
          }
          start = -1;
        }
      }
    }
    return objects;
  }

  private budgetForRole(role: string): {
    maxIterations: number;
    maxToolCalls: number;
    timeoutMs: number;
  } {
    if (this.options.budgetOverrides?.[role]) {
      return (
        this.options.budgetOverrides[role] ?? { maxIterations: 0, maxToolCalls: 0, timeoutMs: 0 }
      );
    }
    const defaults: Record<
      string,
      { maxIterations: number; maxToolCalls: number; timeoutMs: number }
    > = {
      'bug-hunter': { maxIterations: 2000, maxToolCalls: 5000, timeoutMs: 10 * 60 * 1000 },
      'refactor-planner': { maxIterations: 1500, maxToolCalls: 4000, timeoutMs: 8 * 60 * 1000 },
      critic: { maxIterations: 1000, maxToolCalls: 3000, timeoutMs: 6 * 60 * 1000 },
    };
    return defaults[role] ?? { maxIterations: 1500, maxToolCalls: 4000, timeoutMs: 8 * 60 * 1000 };
  }

  private async spawnAgent(
    role: string,
    taskBrief: string,
  ): Promise<{ subagentId: string; taskId: string }> {
    const budget = this.budgetForRole(role);
    const cfg: SubagentConfig = {
      id: `${role}-${this.sessionId}`,
      name: role,
      role,
      tools: ['fleet_emit', 'fleet', 'read', 'grep', 'glob', 'bash', 'write'],
      maxIterations: budget.maxIterations,
      maxToolCalls: budget.maxToolCalls,
      timeoutMs: budget.timeoutMs,
    };
    const subagentId = await this.director.spawn(cfg);
    // Record immediately so a partial-spawn failure (a sibling throw,
    // an assign rejection, a spawn cap) makes this agent visible to
    // getSubagentIds() — the controller uses it to stop orphans.
    this.subagentIds.set(role, subagentId);
    const taskId = await this.director.assign({
      id: randomUUID(),
      subagentId,
      description: taskBrief,
    });
    return { subagentId, taskId };
  }

  private buildBugHunterTask(): string {
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    const fileContents = this.snapshot.files
      .map((f) => `=== ${f.path} ===\n${f.content}`)
      .join('\n\n');
    return (
      `You are BugHunter. Scan the following files for bugs and code smells.\n\n` +
      `Target files:\n${fileContents}\n\n` +
      `For each bug found, emit it using the fleet_emit tool immediately:\n` +
      `{ "type": "bug.found", "payload": { "finding": { "id": "<uuid>", "type": "<pattern>", ` +
      `"severity": "<critical|high|medium|low>", ` +
      `"location": { "file": "<path>", "line": <n> }, "description": "<explain>", "suggestedFix": "<optional>" } } }\n\n` +
      `After scanning all files, write your full markdown bug report to:\n` +
      `${scratchpad}/bug-hunter-report-${this.sessionId}.md\n\n` +
      `Important: emit each finding as soon as you find it. Do not batch or wait until the end.`
    );
  }

  private buildRefactorPlannerTask(): string {
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    const bugHunterReportPath = `${scratchpad}/bug-hunter-report-${this.sessionId}.md`;
    const fileContents = this.snapshot.files
      .map((f) => `=== ${f.path} ===\n${f.content}`)
      .join('\n\n');
    return (
      `You are RefactorPlanner. Plan refactorings for the following files.\n\n` +
      `Target files:\n${fileContents}\n\n` +
      `Read the BugHunter report at: ${bugHunterReportPath}\n\n` +
      `For each bug you can address, emit a refactor plan using fleet_emit:\n` +
      `{ "type": "refactor.plan", "payload": { "plan": { "id": "<uuid>", "basedOnBugIds": ["<bug-id>"], ` +
      `"phases": [{ "number": 1, "title": "<phase>", "tasks": ["<task>"], "risk": "<low|medium|high>" }], ` +
      `"riskScore": "<low|medium|high>", "estimatedChangeCount": <n>, "rollbackStrategy": "<text>" } } }\n\n` +
      `Also write your full markdown plan to:\n` +
      `${scratchpad}/refactor-plan-${this.sessionId}.md\n\n` +
      `Emit each plan immediately. Do not wait until planning is complete.`
    );
  }

  private buildCriticTask(): string {
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    const bugHunterReportPath = `${scratchpad}/bug-hunter-report-${this.sessionId}.md`;
    const refactorPlanPath = `${scratchpad}/refactor-plan-${this.sessionId}.md`;
    const fileContents = this.snapshot.files
      .map((f) => `=== ${f.path} ===\n${f.content}`)
      .join('\n\n');
    return (
      `You are Critic. Evaluate bug findings and refactor plans.\n\n` +
      `Target files:\n${fileContents}\n\n` +
      `Read the BugHunter report at: ${bugHunterReportPath}\n` +
      `Read the RefactorPlanner report at: ${refactorPlanPath}\n\n` +
      `For each bug and refactor plan, emit your evaluation using fleet_emit:\n` +
      `{ "type": "critic.evaluation", "payload": { "evaluation": { "id": "<uuid>", ` +
      `"subjectType": "<bug_finding|refactor_plan>", "subjectId": "<id>", ` +
      `"score": <0-10>, "verdict": "<approve|needs_revision|reject>", ` +
      `"strengths": ["<strength>"], "weaknesses": ["<weakness>"], ` +
      `"concerns": [{ "description": "<concern>", "severity": "<blocking|advisory>" }] } } }\n\n` +
      `After all evaluations, write your markdown report to:\n` +
      `${scratchpad}/critic-report-${this.sessionId}.md\n\n` +
      `Emit each evaluation immediately. Do not wait until you have read all reports.`
    );
  }

  private wireFleetBus(): void {
    // Track tool executions for progress-based timeout decisions
    const dTool = this.fleetBus.filter('tool.executed', (e) => {
      this.progressBySubagent.set(
        e.subagentId,
        (this.progressBySubagent.get(e.subagentId) ?? 0) + 1,
      );
    });
    this.disposers.push(dTool);

    // budget.threshold_reached → Director's alert handler
    const dBudget = this.fleetBus.filter('budget.threshold_reached', (e) => {
      const payload = e.payload as {
        kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
        used: number;
        limit: number;
        timeoutMs?: number | undefined;
        extend: (extra: Record<string, unknown>) => void;
        deny: () => void;
      };
      const role = this.roleFromSubagentId(e.subagentId);
      if (!role) return;

      // Gather /btw notes so the Director can inspect them before deciding
      const btwNotes = this.director.getLeaderBtwNotes();

      const alert: DirectorAlert = {
        sessionId: this.sessionId,
        subagentId: e.subagentId,
        role,
        level: DirectorAlertLevel.WARNING,
        message: `${role} hit ${payload.kind} soft limit (${payload.used}/${payload.limit})`,
        budgetKind: payload.kind,
        // `used` is elapsed milliseconds for timeout kinds. `timeoutMs` is the
        // negotiation response deadline (normally 60s), not agent runtime.
        elapsedMs:
          payload.kind === 'timeout' || payload.kind === 'idle_timeout' ? payload.used : undefined,
        limit: payload.limit,
        btwNotes,
      };

      this.alerts.push(alert);

      this.fleetBus.emit({
        subagentId: e.subagentId,
        ts: Date.now(),
        type: 'collab.warning',
        payload: alert,
      });

      const decision = this.options.onBudgetWarning?.(alert) ?? 'ignore';

      if (decision === 'cancel') {
        this.cancel(`Director cancelled: ${role} ${payload.kind} threshold`);
        return;
      }

      // Progress-based timeout handling: extend if agent is doing work,
      // deny only if genuinely stuck (no tool calls since last grant).
      // Both wall-clock timeout and idle timeout use this heartbeat-aware path.
      if (payload.kind === 'timeout' || payload.kind === 'idle_timeout') {
        const progress = this.progressBySubagent.get(e.subagentId) ?? 0;
        const lastProgress = this.lastTimeoutProgress.get(e.subagentId) ?? -1;
        if (progress <= lastProgress) {
          payload.deny();
          return;
        }
        this.lastTimeoutProgress.set(e.subagentId, progress);
        // Extend the agent's current wall/idle limit. `payload.timeoutMs` is
        // only how long the coordinator may take to answer this negotiation;
        // using it here can shrink a 15-minute agent budget to 2 minutes.
        const newLimit = Math.min(Math.ceil(payload.limit * 2), 24 * 60 * 60_000);
        setImmediate(() => {
          const field = payload.kind === 'timeout' ? 'timeoutMs' : 'idleTimeoutMs';
          payload.extend({ [field]: newLimit });
        });
        return;
      }

      if (decision === 'extend') {
        setImmediate(() => {
          const base = Math.max(payload.limit, payload.used);
          const extra: Record<string, unknown> = {};
          switch (payload.kind) {
            case 'iterations':
              extra.maxIterations = Math.min(Math.ceil(base * 1.5), 50_000);
              break;
            case 'tool_calls':
              extra.maxToolCalls = Math.min(Math.ceil(base * 1.5), 100_000);
              break;
            case 'tokens':
              extra.maxTokens = Math.min(Math.ceil(base * 1.5), 5_000_000);
              break;
            case 'cost':
              extra.maxCostUsd = Math.min(base * 1.5, 100);
              break;
          }
          payload.extend(extra);
        });
        return;
      }

      // 'ignore' (or any unrecognized decision): apply a conservative
      // auto-extension for non-timeout kinds so the session keeps making
      // progress rather than hitting a hard limit. The Director sees the
      // collab.warning event and can always call cancelCollabSession() if the
      // pattern looks like a bad infinite loop. Timeout kind is already handled
      // above by the progress-based logic.
      if ((payload.kind as string) !== 'timeout') {
        setImmediate(() => {
          const base = Math.max(payload.limit, payload.used);
          const extra: Record<string, unknown> = {};
          switch (payload.kind) {
            case 'iterations':
              extra.maxIterations = Math.min(Math.ceil(base * 1.25), 50_000);
              break;
            case 'tool_calls':
              extra.maxToolCalls = Math.min(Math.ceil(base * 1.25), 100_000);
              break;
            case 'tokens':
              extra.maxTokens = Math.min(Math.ceil(base * 1.25), 5_000_000);
              break;
            case 'cost':
              extra.maxCostUsd = Math.min(base * 1.25, 100);
              break;
          }
          payload.extend(extra);
        });
      }
    });
    this.disposers.push(dBudget);

    // Director cancel signal
    const dCancel = this.fleetBus.filter('director.cancel_collab', (e) => {
      const payload = e.payload as DirectorCancelCollabPayload;
      if (payload.sessionId !== this.sessionId) return;
      this.cancelled = true;
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = undefined;
      }
      this.fleetBus.emit({
        subagentId: this.director.id,
        ts: Date.now(),
        type: 'collab.cancelled',
        payload: { sessionId: this.sessionId, reason: payload.reason },
      });
    });
    this.disposers.push(dCancel);

    // bug.found → RefactorPlanner + Critic
    const d1 = this.fleetBus.filter('bug.found', (e) => {
      const payload = e.payload as BugFoundPayload;
      if (payload?.finding) {
        this.bugs.set(payload.finding.id, payload.finding);
        this.emit('bug.found', payload);
      }
    });
    this.disposers.push(d1);

    // refactor.plan → Critic
    const d2 = this.fleetBus.filter('refactor.plan', (e) => {
      const payload = e.payload as RefactorPlanPayload;
      if (payload?.plan) {
        this.plans.set(payload.plan.id, payload.plan);
        this.emit('refactor.plan', payload);
      }
    });
    this.disposers.push(d2);

    // critic.evaluation
    const d3 = this.fleetBus.filter('critic.evaluation', (e) => {
      const payload = e.payload as CriticEvaluationPayload;
      if (payload?.evaluation) {
        this.evaluations.set(payload.evaluation.id, payload.evaluation);
        this.emit('critic.evaluation', payload);
      }
    });
    this.disposers.push(d3);
  }

  private roleFromSubagentId(subagentId: string): string | null {
    // Fast path: check tracked subagentIds map first (normal case during session).
    for (const [role, id] of this.subagentIds) {
      if (id === subagentId) return role;
    }
    // Fallback: derive from id prefix pattern used in spawnAgent.
    // Handles budget events that fire before subagentIds entry is populated
    // (edge case at session start — race between first tool call and map insert).
    const match = subagentId.match(/^(bug-hunter|refactor-planner|critic)/);
    return match?.[1] ?? null;
  }

  private assembleReport(): CollabDebugReport {
    const bugList = Array.from(this.bugs.values());
    const planList = Array.from(this.plans.values());
    const evalList = Array.from(this.evaluations.values());

    let disposition: CollabDebugReport['disposition'] = 'completed';
    if (this.cancelled) disposition = 'cancelled';

    const verdictOrder: Record<CollabDebugReport['overallVerdict'], number> = {
      approve: 0,
      needs_revision: 1,
      reject: 2,
    };
    const overallVerdict = evalList.reduce<CollabDebugReport['overallVerdict']>((worst, eval_) => {
      const w = verdictOrder[worst];
      const c = verdictOrder[eval_.verdict];
      return c > w ? eval_.verdict : worst;
    }, 'approve');

    const summary = this.buildMarkdownSummary(
      bugList,
      planList,
      evalList,
      overallVerdict,
      disposition,
    );

    return {
      sessionId: this.sessionId,
      startedAt: this.snapshot.createdAt,
      completedAt: new Date().toISOString(),
      targetPaths: this.options.targetPaths,
      disposition,
      bugs: bugList,
      refactorPlans: planList,
      evaluations: evalList,
      alerts: [...this.alerts],
      ...(this.snapshotWarnings.length > 0 ? { snapshotWarnings: this.snapshotWarnings } : {}),
      overallVerdict,
      summary,
    };
  }

  private async checkSnapshotFreshness(): Promise<string[]> {
    const warnings: string[] = [];
    for (const file of this.snapshot.files) {
      if (file.snapshotMtimeMs === undefined && file.snapshotSizeBytes === undefined) continue;
      try {
        const stat = await fsp.stat(file.path);
        const mtimeChanged =
          file.snapshotMtimeMs !== undefined && stat.mtimeMs > file.snapshotMtimeMs + 1;
        const sizeChanged =
          file.snapshotSizeBytes !== undefined && stat.size !== file.snapshotSizeBytes;
        if (mtimeChanged || sizeChanged) {
          warnings.push(`${file.path} changed after the collab snapshot was captured.`);
        }
      } catch {
        warnings.push(`${file.path} could not be checked after the collab snapshot was captured.`);
      }
    }
    return warnings;
  }

  private buildMarkdownSummary(
    bugs: BugFinding[],
    plans: RefactorPlan[],
    evals: CriticEvaluation[],
    overallVerdict: CollabDebugReport['overallVerdict'],
    disposition: CollabDebugReport['disposition'],
  ): string {
    const lines: string[] = [
      `## Collaborative Debugging Report — ${this.sessionId}`,
      '',
      `**Target:** ${this.options.targetPaths.join(', ')}`,
      `**Disposition:** ${disposition.toUpperCase()}`,
      `**Overall Verdict:** **${overallVerdict.toUpperCase()}**`,
      '',
    ];

    if (this.alerts.length > 0) {
      lines.push('### Alerts', '');
      for (const alert of this.alerts) {
        lines.push(`- **[${alert.level.toUpperCase()}]** ${alert.role}: ${alert.message}`);
      }
      lines.push('');
    }

    if (this.snapshotWarnings.length > 0) {
      lines.push('### Snapshot Warnings', '');
      for (const warning of this.snapshotWarnings) {
        lines.push(`- ${warning}`);
      }
      lines.push('');
    }

    if (bugs.length > 0) {
      lines.push('### Bugs Found', '');
      for (const b of bugs) {
        lines.push(
          `- **[${b.severity.toUpperCase()}]** \`${b.location.file}:${b.location.line}\` — ${b.description}`,
        );
      }
      lines.push('');
    }

    if (plans.length > 0) {
      lines.push('### Refactor Plans', '');
      for (const p of plans) {
        lines.push(`- **Phase plan** (risk: ${p.riskScore}, ~${p.estimatedChangeCount} changes)`);
        for (const phase of p.phases) {
          lines.push(`  - Phase ${phase.number}: ${phase.title} [${phase.risk}]`);
        }
      }
      lines.push('');
    }

    if (evals.length > 0) {
      lines.push('### Critic Evaluations', '');
      for (const e of evals) {
        lines.push(`- [${e.subjectType}] score=${e.score}/10 — **${e.verdict.toUpperCase()}**`);
        for (const c of e.concerns) {
          if (c.severity === 'blocking') lines.push(`  - ${c.description}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private cleanup(): void {
    // Clear the session-level timeout timer. Without this, the SUCCESS path
    // (Promise.race resolved via awaitTasks) leaves the setTimeout armed: it
    // keeps the event loop alive for up to timeoutMs, then fires a spurious
    // cancel() and rejects the now-orphaned `timeout` promise — an unhandled
    // rejection after every completed session. cleanup() runs on both the
    // success and error paths, so it's the right single owner of the timer.
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    // Release snapshot file contents to free memory; keep the snapshot object
    // itself so the report (already assembled) remains valid.
    this.snapshot.files.length = 0;
  }
}
