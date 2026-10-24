/**
 * GoalPlanner - converts a goal into phases using a real LLM call,
 * producing a large task list with todos under each phase.
 *
 * Similar to SDD's spec-to-task flow, but different: the output is directly
 * `PhaseTemplate[]`; each phase carries `taskTemplates`, so
 * `PhaseGraphBuilder` produces a populated `PhaseGraph` and `PhaseOrchestrator`
 * runs each task through a real agent execution.
 *
 * The planner is not tied to a specific LLM: callers provide a `runOnce(prompt)` function
 * (a subagent run in the CLI, or a deterministic stub in tests).
 */

import type { TaskPriority, TaskType } from '@wrongstack/contracts/types/task-graph';
import { readBundledInstructionText, renderInstructionTemplate } from '@wrongstack/core/utils';
import type { PhaseNode, PhaseTemplate } from './types.js';

/** Single todo template, the element type of PhaseTemplate.taskTemplates. */
type PhaseTaskTemplate = NonNullable<PhaseTemplate['taskTemplates']>[number];

export interface GoalPlannerOptions {
  /**
   * One-shot LLM call: receives a prompt and returns the model text output.
   * In the CLI this wraps subagent.run; in tests it can be a deterministic stub.
   */
  runOnce: (prompt: string) => Promise<string>;
  /** Goal or project title. */
  goal: string;
  /** Optional project context such as package.json or directory structure. */
  projectContext?: string | undefined;
  /** Requested minimum phase count. Defaults to 3. */
  minPhases?: number | undefined;
  /** Requested maximum phase count. Defaults to 8. */
  maxPhases?: number | undefined;
  /** Target todo count per phase. Defaults to 6. */
  todosPerPhase?: number | undefined;
  /**
   * Maximum total tasks across all phases. When set, plans exceeding
   * this limit will have `budgetExceeded: true` and `warnings` will
   * describe the overage. Defaults to 0 (no limit).
   */
  maxTotalTasks?: number | undefined;
  /**
   * Follow-up calls that ask the model to convert a non-JSON answer (e.g. a
   * Markdown plan written to some other format guidance) into the schema.
   * Defaults to 1; 0 disables. An empty answer is never repaired, since that
   * means the run failed rather than the format.
   */
  repairAttempts?: number | undefined;
}

export interface GoalPlanResult {
  /** Phase templates passed to PhaseGraphBuilder. */
  phases: PhaseTemplate[];
  /** Raw model output for debugging and logs. */
  raw: string;
  /** True when JSON could not be parsed; `phases` is empty in that case. */
  parseFailed: boolean;
  /** Validation warnings collected during coercion (e.g. invalid priority defaults). */
  warnings: string[];
  /**
   * Rough cost estimate (in tokens) for executing this plan.
   * Based on estimated task count × average per-task LLM round-trip.
   */
  estimatedCostTokens?: number | undefined;
  /** True when the plan exceeds `maxTotalTasks` budget. */
  budgetExceeded?: boolean | undefined;
  /** True when the plan came from a conversion follow-up, not the first answer. */
  repaired?: boolean | undefined;
}

/** Cap on how much of a rejected answer is sent back for conversion. */
const MAX_REPAIR_SOURCE_CHARS = 24_000;

const VALID_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  'feature',
  'bugfix',
  'refactor',
  'docs',
  'test',
  'chore',
]);
const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set(['critical', 'high', 'medium', 'low']);

/**
 * GoalPlanner drives the model through `plan()` and produces `PhaseTemplate[]`.
 */
export class GoalPlanner {
  constructor(private readonly opts: GoalPlannerOptions) {}

  /** Convert the goal into a phase-and-todo plan. */
  async plan(): Promise<GoalPlanResult> {
    const prompt = this.buildPrompt();
    let raw = await this.opts.runOnce(prompt);
    let { phases, warnings } = this.parse(raw);
    let repaired = false;
    const repairAttempts = this.opts.repairAttempts ?? 1;
    for (let attempt = 0; phases.length === 0 && attempt < repairAttempts; attempt++) {
      if (!raw.trim()) break;
      const rejected = warnings.join('; ') || 'no executable phases';
      raw = await this.opts.runOnce(this.buildRepairPrompt(raw));
      const next = this.parse(raw);
      phases = next.phases;
      warnings = [`First planner answer was unusable (${rejected}); asked for a conversion.`];
      warnings.push(...next.warnings);
      repaired = phases.length > 0;
    }
    // Rough cost estimate: each task runs ~5 LLM round-trips at ~2k tokens each.
    const totalTasks = phases.reduce((s, p) => s + (p.taskTemplates?.length ?? 0), 0);
    const estimatedCostTokens = totalTasks > 0 ? totalTasks * 5 * 2000 : undefined;
    // Budget check: reject plans that exceed maxTotalTasks.
    const maxTotal = this.opts.maxTotalTasks ?? 0;
    let budgetExceeded = false;
    if (maxTotal > 0 && totalTasks > maxTotal) {
      warnings.push(
        `Plan has ${totalTasks} total tasks, exceeding the limit of ${maxTotal}. ` +
          `Consider narrowing the scope or increasing the limit.`,
      );
      budgetExceeded = true;
    }
    return {
      phases,
      raw,
      parseFailed: phases.length === 0,
      warnings,
      estimatedCostTokens,
      budgetExceeded,
      repaired,
    };
  }

  /** Follow-up prompt that converts an off-format answer into the plan schema. */
  buildRepairPrompt(previous: string): string {
    const source =
      previous.length > MAX_REPAIR_SOURCE_CHARS
        ? `${previous.slice(0, MAX_REPAIR_SOURCE_CHARS)}\n[…truncated]`
        : previous;
    return renderInstructionTemplate(readBundledInstructionText('goal/phase-plan-repair.md'), {
      goal: this.opts.goal,
      previous: source,
    });
  }

  /** Instruction prompt for the plan the model should produce. */
  buildPrompt(): string {
    const minP = this.opts.minPhases ?? 3;
    const maxP = this.opts.maxPhases ?? 8;
    const todos = this.opts.todosPerPhase ?? 6;
    const ctx = this.opts.projectContext?.trim();

    return renderInstructionTemplate(readBundledInstructionText('goal/phase-planner.md'), {
      minPhases: String(minP),
      maxPhases: String(maxP),
      todosPerPhase: String(todos),
      goal: this.opts.goal,
      projectContext: ctx ? `\nPROJECT CONTEXT:\n${ctx}\n` : '',
    });
  }

  /** Extract JSON from raw output, validate it, and convert it to PhaseTemplate[].
   *  Returns `{ phases, warnings }` where warnings describe coerced defaults. */
  parse(raw: string): { phases: PhaseTemplate[]; warnings: string[] } {
    const json = extractJSONArray(raw);
    if (!json) return { phases: [], warnings: ['No JSON array found in model output'] };
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return { phases: [], warnings: ['Failed to parse JSON from model output'] };
    }
    if (!Array.isArray(data)) return { phases: [], warnings: ['Model output is not a JSON array'] };
    const warnings: string[] = [];
    const phases: PhaseTemplate[] = [];
    for (const entry of data) {
      const result = this.coercePhase(entry);
      if (result) {
        warnings.push(...result.warnings);
        // A phase without executable work is not a valid autonomous phase.
        // Keeping it used to let the orchestrator observe 0 failed tasks,
        // skip verification, and mark the phase completed in a few ms.
        // Dynamic follow-up work is not represented by PhaseTemplate, so make
        // that unsupported plan shape explicit instead of silently succeeding.
        if (result.phase.taskTemplates?.length) {
          phases.push(result.phase);
        } else {
          warnings.push(`Phase "${result.phase.name}" has no executable tasks and was rejected.`);
        }
      }
    }
    return { phases, warnings };
  }

  private coercePhase(entry: unknown): { phase: PhaseTemplate; warnings: string[] } | null {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) return null;
    const w: string[] = [];
    const rawTasks = Array.isArray(e.tasks)
      ? e.tasks
      : Array.isArray(e.taskTemplates)
        ? e.taskTemplates
        : [];

    const taskTemplates: PhaseTaskTemplate[] = [];
    for (const t of rawTasks) {
      const result = this.coerceTask(t);
      if (result) {
        taskTemplates.push(result.task);
        w.push(...result.warnings);
      }
    }

    const coercedPriority = coercePriority(e.priority);
    if (typeof e.priority === 'string' && coercedPriority !== e.priority) {
      w.push(
        'Phase "' +
          name +
          '": invalid priority "' +
          String(e.priority) +
          '", defaulting to "' +
          coercedPriority +
          '"',
      );
    }
    return {
      phase: {
        name,
        description: typeof e.description === 'string' ? e.description : '',
        priority: coercedPriority as PhaseNode['priority'],
        estimateHours: coerceHours(e.estimateHours, 4),
        parallelizable: e.parallelizable === true,
        taskTemplates,
      },
      warnings: w,
    };
  }

  private coerceTask(t: unknown): { task: PhaseTaskTemplate; warnings: string[] } | null {
    if (!t || typeof t !== 'object') return null;
    const o = t as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) return null;

    const w: string[] = [];
    let type: TaskType = 'feature';
    if (typeof o.type === 'string') {
      if (VALID_TASK_TYPES.has(o.type as TaskType)) {
        type = o.type as TaskType;
      } else {
        w.push('Task "' + title + '": invalid type "' + o.type + '", defaulting to "feature"');
      }
    }
    const coercedPriority = coercePriority(o.priority);
    if (typeof o.priority === 'string' && coercedPriority !== o.priority) {
      w.push(
        'Task "' +
          title +
          '": invalid priority "' +
          String(o.priority) +
          '", defaulting to "' +
          coercedPriority +
          '"',
      );
    }

    return {
      task: {
        title,
        description: typeof o.description === 'string' ? o.description : '',
        type,
        priority: coercedPriority,
        estimateHours: coerceHours(o.estimateHours, 2),
        tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
      },
      warnings: w,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function coercePriority(value: unknown): TaskPriority {
  return VALID_PRIORITIES.has(value as TaskPriority) ? (value as TaskPriority) : 'medium';
}

function coerceHours(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Bound on bracket starts tried per candidate, so prose full of links stays linear-ish. */
const MAX_ARRAY_STARTS = 256;

/**
 * Extract the first JSON array from text. Searches every ``` code block in
 * order, then the whole text, and returns the first balanced `[ ... ]` (aware
 * of strings and escapes) that parses as a JSON array. Markdown around a plan
 * is full of brackets — links, checkboxes, tables — and an earlier fence may
 * hold a shell snippet, so the first bracket is not necessarily the plan.
 * A non-empty array wins over an empty one (a Markdown `[ ]` checkbox parses).
 * When nothing parses, the first balanced block is returned so the caller can
 * report a parse failure rather than "no array".
 */
export function extractJSONArray(text: string): string | null {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1] ?? '')
    .filter(Boolean);
  candidates.push(text);

  let firstBalanced: string | null = null;
  let firstEmpty: string | null = null;
  for (const candidate of candidates) {
    let from = 0;
    for (let tries = 0; tries < MAX_ARRAY_STARTS; tries++) {
      const start = candidate.indexOf('[', from);
      if (start === -1) break;
      const balanced = balancedArrayAt(candidate, start);
      if (balanced) {
        firstBalanced ??= balanced;
        const length = parsedArrayLength(balanced);
        if (length > 0) return balanced;
        if (length === 0) firstEmpty ??= balanced;
      }
      from = start + 1;
    }
  }
  return firstEmpty ?? firstBalanced;
}

/** Element count when `json` parses as an array, otherwise -1. */
function parsedArrayLength(json: string): number {
  try {
    const data: unknown = JSON.parse(json);
    return Array.isArray(data) ? data.length : -1;
  } catch {
    return -1;
  }
}

/** Return the balanced `[ ... ]` block opening at `start`, aware of strings and escapes. */
function balancedArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
