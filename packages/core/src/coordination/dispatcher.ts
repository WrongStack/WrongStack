/**
 * Smart agent dispatcher.
 *
 * Routes a free-form task description to the best agent in the catalog using a
 * two-stage strategy:
 *
 *   1. Heuristic — keyword/phrase scoring against each agent's `capability`
 *      metadata. Deterministic, instant, no provider call. Multi-word phrases
 *      score higher than single words (they're more specific signals).
 *
 *   2. LLM fallback — when the heuristic is ambiguous (confidence below the
 *      threshold, or no keyword hit at all) an injected `classifier` resolves
 *      the tie. The classifier is provider-agnostic: callers wire it to any
 *      `complete(prompt) => text` function via `makeLLMClassifier`, so core
 *      stays free of provider dependencies and the path is unit-testable.
 *
 * If neither stage yields a confident pick, the dispatcher falls back to the
 * `executor` generalist rather than failing.
 */

import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';
import { safeParse } from '../utils/safe-json.js';
import { AGENT_CATALOG, type AgentDefinition } from './agents/index.js';

/** Default agent used when nothing else matches — the generalist builder. */
export const DEFAULT_DISPATCH_ROLE = 'executor';

/** Fallback agent definition for catalog lookup failures. */
const FALLBACK_DEFINITION: AgentDefinition = {
  config: { role: 'unknown', name: 'Unknown Agent' },
  budget: {},
  capability: { phase: 'meta', summary: '', keywords: [] },
};

export interface DispatchCandidate {
  role: string;
  name: string;
  score: number;
  /** Capability keywords that matched the task text. */
  matched: string[];
}

export type DispatchMethod = 'heuristic' | 'llm' | 'fallback';

export interface DispatchResult {
  role: string;
  definition: AgentDefinition;
  /** 0..1 — heuristic margin, or 1 when an LLM made a definite choice. */
  confidence: number;
  method: DispatchMethod;
  /** Human-readable explanation of why this agent was chosen. */
  reason: string;
  /** Runner-up candidates (top heuristic scorers), best-first. */
  alternatives: DispatchCandidate[];
}

/**
 * Provider-agnostic classifier seam. Given the task and the candidate agents
 * (role + summary), return the chosen role (and optional reason), or null to
 * decline. Wire via `makeLLMClassifier`.
 *
 * `differentiatesFrom` is present for roles that declare a
 * `capability.rationale`. The classifier only ever runs on an ambiguous task —
 * that is exactly when two siblings share vocabulary and a summary alone
 * cannot separate them — so the contrast line is the most useful thing to hand
 * it. Optional: legacy roles omit the rationale and the classifier falls back
 * to `summary` for those.
 */
export type DispatchClassifier = (
  task: string,
  candidates: {
    role: string;
    name: string;
    summary: string;
    differentiatesFrom?: string | undefined;
  }[],
) => Promise<{ role: string; reason?: string | undefined } | null>;

export interface DispatchOptions {
  /** Optional LLM fallback for ambiguous tasks. */
  classifier?: DispatchClassifier | undefined;
  /** Heuristic confidence below this triggers the classifier. Default 0.4. */
  confidenceThreshold?: number | undefined;
  /** How many top candidates to offer the classifier. Default 6. */
  maxCandidates?: number | undefined;
  /** Override the catalog (testing). Defaults to the full `AGENT_CATALOG`. */
  catalog?: Record<string, AgentDefinition> | undefined;
}

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Score every agent against the task. A keyword hit adds 1 point; a multi-word
 * keyword phrase adds points equal to its word count (more specific = stronger
 * signal). Returns candidates sorted best-first, zero-score agents dropped.
 */
export function scoreAgents(
  task: string,
  catalog: Record<string, AgentDefinition> = AGENT_CATALOG,
): DispatchCandidate[] {
  // Tokenize once — O(task words) — then do O(1) set lookups per keyword
  const haySet = new Set(normalize(task).split(/\s+/).filter(Boolean));
  const out: DispatchCandidate[] = [];
  for (const def of Object.values(catalog)) {
    if (!def?.config?.role) continue;
    let score = 0;
    const matched: string[] = [];
    for (const kw of def.capability.keywords) {
      const needleWords = normalize(kw).split(/\s+/).filter(Boolean);
      // Check if all words in the keyword phrase are present in the task
      const allPresent = needleWords.every((w) => haySet.has(w));
      if (allPresent) {
        score += needleWords.length;
        matched.push(kw);
      }
    }
    if (score > 0) {
      out.push({ role: def.config.role, name: def.config.name, score, matched });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Heuristic confidence from the score distribution: the margin between the top
 * candidate and the runner-up, scaled by the top score's strength. A clear
 * winner (high top, low second) approaches 1; a near-tie approaches 0.
 */
function heuristicConfidence(candidates: DispatchCandidate[]): number {
  if (candidates.length === 0) return 0;
  const top = candidates[0]?.score ?? 0;
  const second = candidates[1]?.score ?? 0;
  // Strength factor: a single weak match (score 1) shouldn't read as confident.
  const strength = Math.min(1, top / 3);
  const margin = (top - second + 1) / (top + 1);
  return Math.min(1, strength * margin);
}

/**
 * Route a task to the best agent. Async because the LLM fallback may run; the
 * pure-heuristic path resolves without awaiting anything.
 */
export async function dispatchAgent(
  task: string,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const threshold = opts.confidenceThreshold ?? 0.4;
  const maxCandidates = opts.maxCandidates ?? 6;

  const candidates = scoreAgents(task, catalog);
  const confidence = heuristicConfidence(candidates);
  const top = candidates[0];

  // Confident heuristic pick — done, no provider call.
  if (top && confidence >= threshold) {
    return {
      role: top.role,
      definition: catalog[top.role] ?? FALLBACK_DEFINITION,
      confidence,
      method: 'heuristic',
      reason: `Matched keywords: ${top.matched.slice(0, 4).join(', ')}`,
      alternatives: candidates.slice(1, maxCandidates),
    };
  }

  // Ambiguous or no signal — ask the classifier if one is wired.
  if (opts.classifier) {
    // Offer the classifier the top heuristic candidates; if there were none,
    // offer the whole catalog so it can still choose.
    const pool = (
      candidates.length > 0
        ? candidates.slice(0, maxCandidates).map((c) => catalog[c.role] ?? FALLBACK_DEFINITION)
        : Object.values(catalog)
    ).map((d) => ({
      role: d.config.role as string,
      name: d.config.name,
      summary: d.capability.summary,
      ...(d.capability.rationale
        ? { differentiatesFrom: d.capability.rationale.differentiatesFrom }
        : {}),
    }));
    try {
      const choice = await opts.classifier(task, pool);
      if (choice && catalog[choice.role]) {
        return {
          role: choice.role,
          definition: catalog[choice.role] ?? FALLBACK_DEFINITION,
          confidence: 1,
          method: 'llm',
          reason: choice.reason ?? 'Selected by LLM classifier',
          alternatives: candidates.slice(0, maxCandidates).filter((c) => c.role !== choice.role),
        };
      }
    } catch {
      // Classifier failure must not break dispatch — fall through to fallback.
    }
  }

  // Best heuristic guess if we have one, else the generalist.
  if (top) {
    return {
      role: top.role,
      definition: catalog[top.role] ?? FALLBACK_DEFINITION,
      confidence,
      method: 'heuristic',
      reason: `Weak match (${top.matched.slice(0, 3).join(', ') || 'low signal'})`,
      alternatives: candidates.slice(1, maxCandidates),
    };
  }
  const fallbackRole = catalog[DEFAULT_DISPATCH_ROLE]
    ? DEFAULT_DISPATCH_ROLE
    : (Object.keys(catalog)[0] ?? DEFAULT_DISPATCH_ROLE);
  return {
    role: fallbackRole,
    definition: catalog[fallbackRole] ?? FALLBACK_DEFINITION,
    confidence: 0,
    method: 'fallback',
    reason: 'No keyword signal; defaulting to the generalist Executor',
    alternatives: [],
  };
}

/**
 * Build a `DispatchClassifier` from a minimal `complete(prompt) => text`
 * function. The caller supplies the provider call; this owns the prompt and
 * the parsing. Keeps `dispatcher` free of any provider import.
 */
export function makeLLMClassifier(
  complete: (prompt: string) => Promise<string>,
): DispatchClassifier {
  return async (task, candidates) => {
    const list = candidates
      .map((c, i) => {
        const line = `${i + 1}. ${c.role} — ${c.summary}`;
        // Only roles that declare a rationale contribute a contrast line; the
        // prompt stays byte-identical for legacy roles that don't.
        return c.differentiatesFrom ? `${line}\n   vs. siblings: ${c.differentiatesFrom}` : line;
      })
      .join('\n');
    const prompt = renderInstructionTemplate(readBundledInstructionText('llm/agent-router.md'), {
      task,
      agents: list,
    });
    const raw = (await complete(prompt)).trim();
    // Tolerate accidental code fences / surrounding text — extract first {...}.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = safeParse<{ role?: unknown | undefined; reason?: unknown | undefined }>(
      match[0],
    );
    if (!parsed.ok || !parsed.value || typeof parsed.value.role !== 'string') return null;
    const role = parsed.value.role.trim();
    const valid = candidates.some((c) => c.role === role);
    if (!valid) return null;
    return {
      role,
      reason: typeof parsed.value.reason === 'string' ? parsed.value.reason : undefined,
    };
  };
}
