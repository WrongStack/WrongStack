/**
 * AutoPhasePlanner — Bir hedefi (goal) gerçek bir LLM çağrısıyla faz faz,
 * her fazın altında bir sürü todo içeren büyük bir task listesine dönüştürür.
 *
 * SDD'nin spec→task akışına benzer ama farklı: burada çıktı doğrudan
 * `PhaseTemplate[]` — her faz `taskTemplates` taşır, böylece
 * `PhaseGraphBuilder` dolu bir `PhaseGraph` üretir ve `PhaseOrchestrator`
 * her görevi gerçek bir agent koşusuyla çalıştırır.
 *
 * Planner LLM'e bağımlı değildir: çağıran taraf bir `runOnce(prompt)` fonksiyonu
 * verir (CLI'de bu bir subagent koşusudur, testte bir stub olabilir).
 */

import type { TaskPriority, TaskType } from '../types/task-graph.js';
import type { PhaseNode, PhaseTemplate } from './types.js';

/** Tek bir todo şablonu — PhaseTemplate.taskTemplates'in eleman tipi. */
type PhaseTaskTemplate = NonNullable<PhaseTemplate['taskTemplates']>[number];

export interface AutoPhasePlannerOptions {
  /**
   * Tek seferlik LLM çağrısı: prompt verir, modelin metin çıktısını döndürür.
   * CLI'de bir subagent.run sarmalayıcısıdır; testte deterministik stub.
   */
  runOnce: (prompt: string) => Promise<string>;
  /** Hedef/proje başlığı. */
  goal: string;
  /** package.json/dizin yapısı gibi opsiyonel proje bağlamı. */
  projectContext?: string;
  /** İstenen minimum faz sayısı (default 3). */
  minPhases?: number;
  /** İstenen maksimum faz sayısı (default 8). */
  maxPhases?: number;
  /** Faz başına hedeflenen todo sayısı (default 6). */
  todosPerPhase?: number;
}

export interface AutoPhasePlanResult {
  /** PhaseGraphBuilder'a verilecek faz şablonları. */
  phases: PhaseTemplate[];
  /** Modelin ham çıktısı (debug/log için). */
  raw: string;
  /** JSON ayrıştırılamadıysa true; bu durumda `phases` boş döner. */
  parseFailed: boolean;
}

const VALID_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  'feature',
  'bugfix',
  'refactor',
  'docs',
  'test',
  'chore',
]);
const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

/**
 * AutoPhasePlanner — `plan()` çağrısı modeli sürer ve `PhaseTemplate[]` üretir.
 */
export class AutoPhasePlanner {
  constructor(private readonly opts: AutoPhasePlannerOptions) {}

  /** Hedefi faz+todo planına dönüştür. */
  async plan(): Promise<AutoPhasePlanResult> {
    const prompt = this.buildPrompt();
    const raw = await this.opts.runOnce(prompt);
    const phases = this.parse(raw);
    return { phases, raw, parseFailed: phases.length === 0 };
  }

  /** Modelin üreteceği plan için talimat prompt'u. */
  buildPrompt(): string {
    const minP = this.opts.minPhases ?? 3;
    const maxP = this.opts.maxPhases ?? 8;
    const todos = this.opts.todosPerPhase ?? 6;
    const ctx = this.opts.projectContext?.trim();

    return [
      'You are an expert software project planner. Break the following goal into',
      `a dependency-ordered list of ${minP}–${maxP} PHASES. Each phase must contain`,
      `roughly ${todos} concrete, individually-actionable TODO tasks.`,
      '',
      `GOAL: ${this.opts.goal}`,
      ctx ? `\nPROJECT CONTEXT:\n${ctx}\n` : '',
      'Rules:',
      '- Phases run in order; earlier phases are prerequisites for later ones.',
      '- Each todo must be small enough for one focused work session.',
      '- Each todo must be self-contained (an agent will execute it in isolation).',
      '- Prefer concrete verbs ("Add X", "Refactor Y", "Write tests for Z").',
      '',
      'Respond with ONLY a JSON array inside a ```json code fence. No prose before',
      'or after. Schema (TypeScript):',
      '',
      '```json',
      '[',
      '  {',
      '    "name": "Phase name",',
      '    "description": "What this phase accomplishes",',
      '    "priority": "critical" | "high" | "medium" | "low",',
      '    "estimateHours": number,',
      '    "parallelizable": boolean,',
      '    "tasks": [',
      '      {',
      '        "title": "Short task title",',
      '        "description": "What to do and how to know it is done",',
      '        "type": "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore",',
      '        "priority": "critical" | "high" | "medium" | "low",',
      '        "estimateHours": number,',
      '        "tags": ["optional", "labels"]',
      '      }',
      '    ]',
      '  }',
      ']',
      '```',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /** Ham çıktıdan JSON'u çıkar, doğrula ve PhaseTemplate[]'e dönüştür. */
  parse(raw: string): PhaseTemplate[] {
    const json = extractJSONArray(raw);
    if (!json) return [];

    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];

    const phases: PhaseTemplate[] = [];
    for (const entry of data) {
      const phase = this.coercePhase(entry);
      if (phase) phases.push(phase);
    }
    return phases;
  }

  private coercePhase(entry: unknown): PhaseTemplate | null {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) return null;

    const rawTasks = Array.isArray(e.tasks)
      ? e.tasks
      : Array.isArray(e.taskTemplates)
        ? e.taskTemplates
        : [];

    const taskTemplates = rawTasks
      .map((t) => this.coerceTask(t))
      .filter((t): t is PhaseTaskTemplate => t !== null);

    return {
      name,
      description: typeof e.description === 'string' ? e.description : '',
      priority: coercePriority(e.priority) as PhaseNode['priority'],
      estimateHours: coerceHours(e.estimateHours, 4),
      parallelizable: e.parallelizable === true,
      taskTemplates,
    };
  }

  private coerceTask(t: unknown): PhaseTaskTemplate | null {
    if (!t || typeof t !== 'object') return null;
    const o = t as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) return null;

    const type: TaskType = VALID_TASK_TYPES.has(o.type as TaskType)
      ? (o.type as TaskType)
      : 'feature';

    return {
      title,
      description: typeof o.description === 'string' ? o.description : '',
      type,
      priority: coercePriority(o.priority),
      estimateHours: coerceHours(o.estimateHours, 2),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
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

/**
 * Bir metinden ilk JSON dizisini çıkarır. Sırasıyla dener:
 *  1. ```json ... ``` (veya çıplak ```) kod bloğu içindeki ilk [ ... ]
 *  2. Metindeki ilk dengeli [ ... ] bloğu (string/escape farkındalıklı)
 */
export function extractJSONArray(text: string): string | null {
  // 1) Fenced code block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const balanced = firstBalancedArray(candidate);
    if (balanced) return balanced;
  }
  return null;
}

/** String/escape farkındalıklı, ilk dengeli `[ ... ]` bloğunu döndürür. */
function firstBalancedArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
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
