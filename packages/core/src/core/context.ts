import * as path from 'node:path';
import type { TextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Provider, Usage } from '../types/provider.js';
import type { SessionWriter } from '../types/session.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';
import { ConversationState } from './conversation-state.js';
import type { RunEnv } from './run-env.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  /** When promoted from a plan item, stores the plan item's id. */
  promotedFromPlan?: string | undefined;
  /** When promoted from a task, stores the task's id. */
  promotedFromTask?: string | undefined;
}

export interface RunOptions {
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  executionStrategy?: 'parallel' | 'sequential' | 'smart' | undefined;
  maxIterations?: number | undefined;
  /**
   * Enable autonomous continue for this specific run. When true, the agent
   * loop re-runs on `[continue]`/`[next step]`/`[proceed]` markers or
   * `continue_to_next_iteration()` tool calls instead of returning.
   * Overrides `AgentInit.autonomousContinue` for this call only.
   */
  autonomousContinue?: boolean | undefined;
}

export interface ContextInit {
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory. Defaults to `cwd`. Must stay within `projectRoot`. */
  workingDir?: string | undefined;
  model: string;
  tools?: Tool[] | undefined;
  /** Agent id performing this run (e.g. 'leader', 'executor', 'tech-stack'). */
  agentId?: string | undefined;
  /** Human-readable agent name. */
  agentName?: string | undefined;
}

/**
 * L1-A: `Context` is the live agent-run object. Its read-only environment
 * shape is exposed by the `RunEnv` interface (every field below the
 * conversation state) and its mutable shape by `ConversationState` (the
 * `state` accessor). New code should declare the narrower type at its
 * parameter — pass `ctx` for it. Existing tools that accept `Context`
 * still work because `Context` structurally satisfies both.
 *
 * The single source of truth for the project directory is `projectRoot`.
 * All tools (read/write/bash/exec) resolve paths relative to this.
 * Sessions, config, memory, and logs are also stored under this root.
 *
 * There IS a mutable `workingDir` (separate from `projectRoot`) that can be
 * changed at runtime via `setWorkingDir()`. It starts as `cwd` and allows
 * the agent and user to navigate within the project without spawning a new
 * process. All changes must stay inside `projectRoot`.
 */
export class Context implements RunEnv {
  messages: Message[] = [];
  todos: TodoItem[] = [];
  readFiles = new Set<string>();
  fileMtimes = new Map<string, number>();
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory — starts as `cwd`. Change via `setWorkingDir()`. */
  workingDir: string;
  model: string;
  tools: Tool[] = [];
  meta: Record<string, unknown> = {};
  /** Agent id performing this run (e.g. 'leader', 'executor'). */
  agentId: string;
  /** Human-readable agent name. */
  agentName: string;

  /** Callbacks fired when `setWorkingDir()` changes the working directory. */
  private _onWorkingDirChanged: Array<(newDir: string, oldDir: string) => void> = [];

  /**
   * Set to true when the conversation gains new tool_use or tool_result
   * blocks — the only time repairToolUseAdjacency() can find new issues.
   * buildAndRunRequestPipeline() checks this flag to skip an O(n) scan
   * on iterations where no tool content was added (pure text responses).
   */
  toolAdjacencyDirty = false;

  /**
   * H1: pre-computed total-request token estimate from the most recent
   * `estimateRequestTokens()` call in the agent loop's pre-flight step.
   * The middleware that decides when to compact, the `emitContextPct`
   * helper that drives the live context-fill bar, and the pre-flight
   * itself all need this number; previously each one walked the same
   * messages/system/tools arrays independently. Stashing it here lets
   * the three call sites share a single compute per iteration.
   *
   * The value is the **uncalibrated** total. Callers that want the
   * calibrated number apply the per-(provider,model) ratio themselves.
   */
  lastRequestTokens: number | undefined = undefined;

  constructor(init: ContextInit) {
    this.systemPrompt = init.systemPrompt;
    this.provider = init.provider;
    this.session = init.session;
    this.signal = init.signal;
    this.tokenCounter = init.tokenCounter;
    this.cwd = init.cwd;
    this.projectRoot = init.projectRoot;
    this.workingDir = init.workingDir ?? init.cwd;
    this.model = init.model;
    this.tools = init.tools ?? [];
    this.agentId = init.agentId ?? 'unknown';
    this.agentName = init.agentName ?? 'Unknown Agent';
  }

  /**
   * Observable wrapper over the mutable conversation state. Lazy so
   * subsystems that don't subscribe pay nothing. Mutations made directly
   * on `ctx.messages` / `ctx.todos` are still visible through this
   * wrapper's read API (it holds a reference, not a copy) but only
   * mutations that go through `state.appendMessage()` etc. fire
   * `onChange`. New code should prefer the wrapper API.
   */
  private _state: ConversationState | null = null;
  get state(): ConversationState {
    if (!this._state) this._state = new ConversationState(this);
    return this._state;
  }

  /**
   * Register a teardown hook tied to the current run's abort signal.
   * Hooks registered before a run starts are stored and fired when the
   * next run ends; there is no immediate fire when no run is active.
   *
   * **Scope:** these hooks fire on the **whole agent run's** abort, not on
   * an individual tool call. For per-tool teardown of resources owned by
   * the tool author (child processes, handles), prefer `Tool.cleanup` —
   * see its JSDoc for the full rule.
   */
  private abortHooks = new Set<() => void | Promise<void>>();
  registerAbortHook(fn: () => void | Promise<void>): () => void {
    this.abortHooks.add(fn);
    return () => this.abortHooks.delete(fn);
  }
  async drainAbortHooks(): Promise<void> {
    const snapshot = [...this.abortHooks].reverse();
    // Clear before running so new hooks registered during iteration
    // fire on the next abort cycle (not the current one — hook chains
    // are intentionally not supported).
    this.abortHooks.clear();
    for (const fn of snapshot) {
      try {
        await fn();
      } catch {
        // hooks must be best-effort; swallow so siblings still fire
      }
    }
  }

  recordRead(absPath: string, mtimeMs: number): void {
    this.readFiles.add(absPath);
    this.fileMtimes.set(absPath, mtimeMs);
  }

  /** Clear accumulated file-read metadata after compaction or at boundaries
   *  where stale read history could cause tools to skip legitimate re-reads.
   *  The agent re-populates this naturally on the next file access. */
  clearFileTracking(): void {
    this.readFiles.clear();
    this.fileMtimes.clear();
  }

  hasRead(absPath: string): boolean {
    return this.readFiles.has(absPath);
  }

  lastReadMtime(absPath: string): number | undefined {
    return this.fileMtimes.get(absPath);
  }

  /**
   * Change the working directory for path resolution. Resolves relative paths
   * against `projectRoot` and validates the result is within the project root.
   * Fires all registered `onWorkingDirChanged` callbacks.
   * Returns the resolved absolute path.
   */
  setWorkingDir(dir: string): string {
    const resolved = path.isAbsolute(dir)
      ? path.resolve(dir)
      : path.resolve(this.projectRoot, dir);

    // Validate containment within projectRoot
    const root = path.resolve(this.projectRoot);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Working directory "${resolved}" is outside project root "${root}"`,
      );
    }

    const old = this.workingDir;
    this.workingDir = resolved;
    // Fire callbacks (catch errors so one bad listener doesn't break others)
    for (const cb of this._onWorkingDirChanged) {
      try { cb(resolved, old); } catch { /* best-effort */ }
    }
    return resolved;
  }

  /**
   * Register a callback that fires when the working directory changes.
   * Returns an unsubscribe function. Callbacks are fired synchronously
   * inside `setWorkingDir()` — errors in callbacks are swallowed so one
   * bad listener doesn't prevent others from executing.
   */
  onWorkingDirChanged(cb: (newDir: string, oldDir: string) => void): () => void {
    this._onWorkingDirChanged.push(cb);
    return () => {
      const idx = this._onWorkingDirChanged.indexOf(cb);
      if (idx >= 0) this._onWorkingDirChanged.splice(idx, 1);
    };
  }

  usage(): Usage {
    return this.tokenCounter.total();
  }
}
