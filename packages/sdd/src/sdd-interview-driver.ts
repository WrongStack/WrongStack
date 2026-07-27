// SddInterviewDriver — a headless, REPL-free wrapper around AISpecBuilder that
// drives the interactive Spec-Driven-Development interview (questioning → spec
// → implementation plan → task graph) from any surface (WebUI, CLI, tests).
//
// The CLI `/sdd` slash command historically owned this loop via module-singleton
// state (`sddState`) plus thin detection helpers in `packages/cli` — which the
// WebUI cannot import (layer rule: webui ⇏ cli). This driver lifts the *pure*
// logic into core so every surface shares one implementation: feed it the
// agent's text output, it detects the spec / plan / task JSON, advances the
// AISpecBuilder phases, and persists the resulting TaskGraph to disk so the run
// machinery (SddParallelRun) can pick it up.
//
// The driver never runs the agent itself — the caller runs `agent.run(prompt)`
// and feeds the output back via `ingestAgentOutput`. That keeps core free of any
// agent-loop / provider coupling.

import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type { Specification, TaskGraph, TaskNode } from '@wrongstack/core/types';
import { buildBoardTasks, type SddBoardColumn, type SddBoardTask } from './board-types.js';
import { AISpecBuilder, type AISpecPhase } from './spec-builder.js';
import type { SpecStore } from './spec-store.js';
import { TaskGenerator } from './task-generator.js';
import type { TaskGraphStore } from './task-graph-store.js';

export interface SddInterviewDriverOptions {
  /** Disk-backed spec store (`wpaths.projectSpecs`). */
  specStore: SpecStore;
  /** Disk-backed task-graph store (`wpaths.projectTaskGraphs`). */
  graphStore: TaskGraphStore;
  /** Persist the interview session here so a reconnect can resume it. */
  sessionPath?: string | undefined;
  /** Project context string injected into the questioning prompt. */
  projectContext?: string | undefined;
  minQuestions?: number | undefined;
  maxQuestions?: number | undefined;
}

/** A serialisable view of the interview, streamed to observing surfaces. */
export interface SddInterviewSnapshot {
  sessionId: string;
  phase: AISpecPhase;
  title: string;
  /** The operator's original goal prompt (verbatim). `title` is a short heading. */
  goal: string;
  questionCount: number;
  minQuestions: number;
  maxQuestions: number;
  answers: Array<{ question: string; answer: string }>;
  /** Last agent utterance (open question / plan prose) — used for resume UI. */
  lastAgentText?: string | undefined;
  /** Most recent run id started from this interview, if any. */
  lastRunId?: string | undefined;
  /** True when this snapshot was rehydrated from disk (not a fresh start). */
  resumed?: boolean | undefined;
  spec?:
    | {
        id: string;
        title: string;
        overview: string;
        requirements: Array<{ priority: string; description: string }>;
      }
    | undefined;
  graphId?: string | undefined;
  taskCount: number;
  /**
   * Topologically-laid-out task graph (once decomposed) — lets the wizard
   * render the same animated DAG as the live board ("decomposition reveal").
   */
  board?: { tasks: SddBoardTask[]; columns: SddBoardColumn[] } | undefined;
  /** The current AI prompt for this phase (what to send the agent next). */
  prompt: string;
}

/** What `ingestAgentOutput` detected and acted on. */
export interface SddIngestResult {
  specDetected: boolean;
  implementationDetected: boolean;
  tasksDetected: boolean;
  graphId?: string | undefined;
}

export class SddInterviewDriver {
  readonly builder: AISpecBuilder;
  private readonly o: SddInterviewDriverOptions;
  private readonly minQuestions: number;
  private readonly maxQuestions: number;
  private tracker: TaskTracker | null = null;
  private graph: TaskGraph | null = null;
  /** Set when {@link loadExisting} successfully rehydrated a session from disk. */
  private resumedFromDisk = false;

  constructor(opts: SddInterviewDriverOptions) {
    this.o = opts;
    this.minQuestions = opts.minQuestions ?? 2;
    this.maxQuestions = opts.maxQuestions ?? 10;
    this.builder = new AISpecBuilder({
      store: opts.specStore,
      sessionPath: opts.sessionPath,
      projectContext: opts.projectContext,
      minQuestions: this.minQuestions,
      maxQuestions: this.maxQuestions,
    });
  }

  /** Begin a fresh interview. Returns the first AI prompt (a question kickoff). */
  start(title: string, intent?: string): string {
    this.builder.resetForNewInterview();
    this.builder.startSession(title, intent);
    this.tracker = null;
    this.graph = null;
    this.resumedFromDisk = false;
    return this.builder.getAIPrompt();
  }

  /**
   * Resume a previously-persisted interview from disk. Re-hydrates the task
   * graph too when one was already produced. Returns true if a session loaded.
   */
  async loadExisting(): Promise<boolean> {
    const loaded = await this.builder.loadSession();
    if (!loaded) return false;
    const graphId = this.builder.getTaskGraphId();
    if (graphId) {
      const graph = await this.o.graphStore.load(graphId);
      if (graph) {
        this.graph = graph;
        const tracker = new TaskTracker({ store: new DefaultTaskStore() });
        tracker.setGraph(graph);
        this.tracker = tracker;
      }
    }
    this.resumedFromDisk = true;
    return true;
  }

  /** Drop the on-disk session (if any) and clear in-memory interview state. */
  async discard(): Promise<void> {
    await this.builder.deleteSession();
    this.builder.resetForNewInterview();
    this.tracker = null;
    this.graph = null;
    this.resumedFromDisk = false;
  }

  setLastAgentText(text: string): void {
    this.builder.setLastAgentText(text);
  }

  getLastAgentText(): string | undefined {
    return this.builder.getLastAgentText();
  }

  setLastRunId(runId: string): void {
    this.builder.setLastRunId(runId);
  }

  getLastRunId(): string | undefined {
    return this.builder.getLastRunId();
  }

  wasResumed(): boolean {
    return this.resumedFromDisk;
  }

  phase(): AISpecPhase {
    return this.builder.getPhase();
  }

  currentPrompt(): string {
    return this.builder.getAIPrompt();
  }

  getTracker(): TaskTracker | null {
    return this.tracker;
  }

  getGraph(): TaskGraph | null {
    return this.graph;
  }

  /** Record a Q/A pair (the agent asked `question`, the user replied `answer`). */
  submitAnswer(question: string, answer: string): void {
    this.builder.addAnswer(question, answer);
  }

  /**
   * Feed the agent's text output back into the interview. Detects, in order:
   *  1. a Specification JSON  → setSpec (phase → spec_review) + persist to SpecStore
   *  2. an implementation plan (implementation phase) → setImplementation
   *  3. a task JSON array      → build + persist a TaskGraph
   * Each step is independent and best-effort; a malformed payload is ignored
   * rather than thrown, so a chatty agent turn never breaks the interview.
   */
  async ingestAgentOutput(text: string): Promise<SddIngestResult> {
    const result: SddIngestResult = {
      specDetected: false,
      implementationDetected: false,
      tasksDetected: false,
    };

    // 1. Spec JSON → spec_review.
    if (!this.builder.getSession().spec) {
      const spec = this.builder.tryParseSpecFromOutput(text);
      if (spec) {
        this.builder.setSpec(spec);
        await this.persistSpec(spec);
        result.specDetected = true;
      }
    }

    // 2. Implementation plan (only meaningful in the implementation phase).
    if (this.builder.getPhase() === 'implementation') {
      if (this.trySaveImplementationPlan(text)) result.implementationDetected = true;
    }

    // 3. Task JSON array → TaskGraph (requires a spec to anchor the graph).
    const session = this.builder.getSession();
    if (session.spec) {
      const built = await this.tryBuildTasksFromOutput(text);
      if (built) {
        result.tasksDetected = true;
        result.graphId = built;
      }
    }

    return result;
  }

  /**
   * Advance to the next phase (mirrors `/sdd approve`). When moving into the
   * executing phase, guarantees a task graph exists — deterministically
   * generating one from the approved spec if the agent never emitted a valid
   * task array. Returns the new phase and its AI prompt.
   */
  async approve(): Promise<{ phase: AISpecPhase; prompt: string }> {
    const phase = this.builder.approve();
    if (phase === 'executing') {
      await this.ensureTaskGraph();
    }
    return { phase, prompt: this.builder.getAIPrompt() };
  }

  /**
   * Ensure a TaskGraph exists for the approved spec. If the agent already
   * produced one (via `ingestAgentOutput`), returns it; otherwise builds a
   * deterministic graph from the spec's requirements via TaskGenerator. This is
   * the robustness backstop: a run can always start, even if the model never
   * emitted a parseable task array.
   */
  async ensureTaskGraph(): Promise<TaskGraph | null> {
    if (this.graph) return this.graph;
    const spec = this.builder.getSession().spec;
    if (!spec) return null;

    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const generator = new TaskGenerator({
      taskTracker: tracker,
      verificationFromAcceptance: process.env['WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE'] === '1',
    });
    const graph = await generator.generateFromSpec(spec);
    this.tracker = tracker;
    this.graph = graph;
    await this.persistGraph(graph);
    this.builder.setTaskGraphId(graph.id);
    // Flush the session synchronously so a reconnect (loadExisting) sees the
    // graphId — setTaskGraphId's own auto-save is fire-and-forget.
    await this.builder.saveSession();
    return graph;
  }

  snapshot(): SddInterviewSnapshot {
    const s = this.builder.getSession();
    const spec = s.spec;
    return {
      sessionId: s.id,
      phase: s.phase,
      title: s.title,
      goal: s.userIntent || s.title,
      questionCount: s.questionCount,
      minQuestions: this.minQuestions,
      maxQuestions: this.maxQuestions,
      answers: s.answers.map((a) => ({ question: a.question, answer: a.answer })),
      lastAgentText: s.lastAgentText,
      lastRunId: s.lastRunId,
      resumed: this.resumedFromDisk || undefined,
      spec: spec
        ? {
            id: spec.id,
            title: spec.title,
            overview: spec.overview,
            requirements: spec.requirements.map((r) => ({
              priority: r.priority,
              description: r.description,
            })),
          }
        : undefined,
      graphId: s.taskGraphId,
      taskCount: this.graph ? this.graph.nodes.size : 0,
      board: this.graph ? buildBoardTasks(this.graph) : undefined,
      prompt: this.builder.getAIPrompt(),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async persistSpec(spec: Specification): Promise<void> {
    try {
      await this.o.specStore.save(spec);
    } catch {
      // best-effort — the in-memory session still has the spec
    }
  }

  private async persistGraph(graph: TaskGraph): Promise<void> {
    try {
      await this.o.graphStore.save(graph);
    } catch {
      // best-effort — the in-memory tracker still drives the run
    }
  }

  /**
   * Port of the CLI `trySaveImplementationPlan` operating on this driver's
   * builder. Captures the prose plan that precedes the task JSON block.
   */
  private trySaveImplementationPlan(text: string): boolean {
    const current = this.builder.getSession().implementation ?? '';
    const jsonStart = text.match(/```json\s*\[/);
    if (jsonStart?.index && jsonStart.index > 0) {
      const plan = text.substring(0, jsonStart.index).trim();
      if (plan.length > 50 && plan !== current && !isExplanatoryText(plan)) {
        this.builder.setImplementation(plan);
        return true;
      }
    }
    if (
      text.length > 100 &&
      !text.includes('```json') &&
      text.trim() !== current &&
      !isExplanatoryText(text)
    ) {
      this.builder.setImplementation(text.trim());
      return true;
    }
    return false;
  }

  /**
   * Port of the CLI `trySaveTasksFromAIOutput`: parse a task JSON array from the
   * agent output, build (or extend) the tracker + graph, persist to disk, and
   * link the graphId to the session. Returns the graphId on success.
   */
  private async tryBuildTasksFromOutput(text: string): Promise<string | undefined> {
    const json = this.builder.extractJSONArray(text);
    if (!json) return undefined;

    let tasks: Array<Record<string, unknown>>;
    try {
      tasks = JSON.parse(json) as Array<Record<string, unknown>>;
    } catch {
      return undefined;
    }
    const valid = tasks.filter(
      (t) => t && typeof t === 'object' && typeof t.title === 'string' && t.title.length > 0,
    );
    if (valid.length === 0) return undefined;

    // ingestAgentOutput only invokes this helper after confirming a spec.
    const spec = this.builder.getSession().spec!;

    if (!this.tracker) {
      const tracker = new TaskTracker({ store: new DefaultTaskStore() });
      this.graph = await tracker.createGraph(spec.id, spec.title);
      this.tracker = tracker;
    }
    const tracker = this.tracker;
    const graph = this.graph!;
    // Two passes: (1) create every node, recording every reference key by which
    // a `dependsOn` entry might name it (declared id, positional `t1`/`1`, title);
    // (2) resolve each task's `dependsOn` refs into real `depends_on` edges. This
    // is what turns a flat task list into a true dependency DAG — the scheduler
    // then runs independent tasks in parallel and dependent ones in order.
    const refMap = new Map<string, string>();
    const created: Array<{ nodeId: string; task: Record<string, unknown> }> = [];
    valid.forEach((task, i) => {
      const node = addTaskToTracker(tracker, task);
      created.push({ nodeId: node.id, task });
      if (typeof task.id === 'string' && task.id.trim()) {
        refMap.set(task.id.trim().toLowerCase(), node.id);
      }
      refMap.set(`t${i + 1}`, node.id);
      refMap.set(String(i + 1), node.id);
      refMap.set(normalizeTaskRef(String(task.title)), node.id);
    });
    for (const { nodeId, task } of created) {
      const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      for (const ref of deps) {
        const depId = refMap.get(normalizeTaskRef(String(ref)));
        // addDependency self/duplicate/cycle-guards; a stale ref just no-ops.
        if (depId && depId !== nodeId) tracker.addDependency(depId, nodeId);
      }
    }
    await this.persistGraph(graph);
    this.builder.setTaskGraphId(graph.id);
    // Flush so a reconnect resumes with the graph linked (see ensureTaskGraph).
    await this.builder.saveSession();
    return graph.id;
  }
}

const TASK_TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'] as const;
const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Normalize a dependsOn reference (id / positional / title) for map lookup. */
function normalizeTaskRef(ref: string): string {
  return ref.trim().toLowerCase();
}

function addTaskToTracker(tracker: TaskTracker, task: Record<string, unknown>): TaskNode {
  return tracker.addNode({
    title: String(task.title),
    description: String(task.description ?? ''),
    type: (TASK_TYPES as readonly string[]).includes(String(task.type))
      ? (String(task.type) as (typeof TASK_TYPES)[number])
      : 'feature',
    priority: (TASK_PRIORITIES as readonly string[]).includes(String(task.priority))
      ? (String(task.priority) as (typeof TASK_PRIORITIES)[number])
      : 'medium',
    status: 'pending',
    estimateHours: Number(task.estimateHours) || 2,
    tags: Array.isArray(task.tags) ? task.tags.map(String) : [],
  });
}

/**
 * True when the text reads like conversational filler rather than a structured
 * implementation plan. Ported verbatim from the CLI detection so behaviour is
 * identical across surfaces.
 */
export function isExplanatoryText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.startsWith("i'") ||
    lower.startsWith('i will') ||
    lower.startsWith('let me') ||
    lower.startsWith("here's my") ||
    lower.startsWith('here is my') ||
    lower.startsWith("i'm going to") ||
    lower.startsWith('first, let me') ||
    lower.startsWith('sure') ||
    lower.startsWith('of course') ||
    lower.startsWith('okay') ||
    lower.startsWith('ok,') ||
    lower.startsWith('sounds good') ||
    lower.startsWith('no problem') ||
    (text.split('\n').length < 3 && !text.includes('.'))
  );
}
