import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';

export interface MemoryInjectorPlanInput {
  ctx: ToolCallPipelinePayload['ctx'];
  trigger: string;
  toolQuery: string;
  baseMaxHints: number;
  baseMaxChars: number;
  taskAware?: boolean | undefined;
}

export interface MemoryInjectorPlan {
  queryText: string;
  taskSignals: string[];
  maxHints: number;
  maxChars: number;
  contextPressure: number;
}

export interface MemoryInjectorMeasurement {
  candidates: number;
  eligible: number;
  injected: number;
  injectedChars: number;
}

/**
 * Task-aware, budget-measuring curator for on-demand memory injection.
 * It stays deterministic because an extra LLM request can cost more context
 * than the memory selection saves.
 */
export class MemoryInjectorAgent {
  plan(input: MemoryInjectorPlanInput): MemoryInjectorPlan {
    // Opt-in, not opt-out: splicing todo/Kanban text into the query searches
    // for what the operator is doing rather than for the file the tool
    // touched, and a memory that matches only that text is unrelated to the
    // result it gets stapled to.
    const taskSignals = input.taskAware === true ? collectTaskSignals(input.ctx) : [];
    const queryText = uniqueTerms([input.toolQuery, ...taskSignals].join(' '), 1_600);
    const contextPressure = readContextPressure(input.ctx);
    const budget =
      contextPressure >= 0.95
        ? { maxHints: 0, maxChars: 0 }
        : contextPressure >= 0.82
          ? { maxHints: 1, maxChars: 600 }
          : contextPressure >= 0.65
            ? { maxHints: 3, maxChars: 1_400 }
            : { maxHints: input.baseMaxHints, maxChars: input.baseMaxChars };
    return {
      queryText,
      taskSignals,
      maxHints: Math.min(input.baseMaxHints, budget.maxHints),
      maxChars: Math.min(input.baseMaxChars, budget.maxChars),
      contextPressure,
    };
  }

  record(
    ctx: ToolCallPipelinePayload['ctx'],
    plan: MemoryInjectorPlan,
    measurement: MemoryInjectorMeasurement,
  ): void {
    ctx.meta ??= {};
    ctx.meta['memoryInjectorLastRun'] = {
      at: new Date().toISOString(),
      queryChars: plan.queryText.length,
      taskSignals: plan.taskSignals.length,
      contextPressure: Number(plan.contextPressure.toFixed(3)),
      budget: { maxHints: plan.maxHints, maxChars: plan.maxChars },
      ...measurement,
    };
  }
}

function collectTaskSignals(ctx: ToolCallPipelinePayload['ctx']): string[] {
  const signals: string[] = [];
  const todos = Array.isArray(ctx.todos) ? ctx.todos : [];
  for (const todo of todos.filter((item) => item.status === 'in_progress').slice(0, 3)) {
    signals.push(todo.activeForm ?? todo.content);
  }
  collectKanbanSignals(ctx.meta?.['kanban'], signals);
  if (ctx.currentKanbanTaskId) signals.push(`kanban-task ${ctx.currentKanbanTaskId}`);
  if (ctx.currentKanbanBoardId) signals.push(`kanban-board ${ctx.currentKanbanBoardId}`);
  return [
    ...new Set(signals.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)),
  ].slice(0, 12);
}

function collectKanbanSignals(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const semanticKeys = [
    'title',
    'name',
    'description',
    'content',
    'activeForm',
    'summary',
    'task',
    'taskTitle',
    'boardTitle',
    'tags',
    'labels',
  ];
  for (const key of semanticKeys) {
    const item = record[key];
    const values =
      typeof item === 'string'
        ? [item]
        : Array.isArray(item)
          ? item.filter((entry): entry is string => typeof entry === 'string')
          : [];
    for (const entry of values) {
      const text = entry.replace(/\s+/g, ' ').trim();
      if (text) out.push(`${key} ${text.slice(0, 400)}`);
      if (out.length >= 8) return;
    }
  }
}

function readContextPressure(ctx: ToolCallPipelinePayload['ctx']): number {
  const used = ctx.lastRequestTokens;
  const learned = ctx.meta?.['effectiveMaxContext'];
  const providerMax = ctx.provider?.capabilities?.maxContext;
  const max =
    typeof learned === 'number' && learned > 0
      ? learned
      : typeof providerMax === 'number' && providerMax > 0
        ? providerMax
        : 0;
  return typeof used === 'number' && used > 0 && max > 0 ? used / max : 0;
}

function uniqueTerms(text: string, maxChars: number): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  let chars = 0;
  for (const term of text.normalize('NFKC').split(/\s+/)) {
    const clean = term.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    if (chars + clean.length + 1 > maxChars) break;
    seen.add(key);
    terms.push(clean);
    chars += clean.length + 1;
  }
  return terms.join(' ');
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const memoryInjectorAgentCoverage = {
  collectTaskSignals,
  collectKanbanSignals,
  readContextPressure,
  uniqueTerms,
};
