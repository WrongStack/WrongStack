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

import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';
import { safeParse } from '../utils/safe-json.js';
import { AGENT_CATALOG, type AgentDefinition, getAgentDefinition } from './agents/index.js';
import type { AgentPhase } from './agents/types.js';

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
  /**
   * Capability keywords the WINNING role matched. Empty when the LLM stage or
   * the generalist fallback decided, which is itself the signal: a role chosen
   * with no keyword behind it is one the heuristic could not see.
   */
  matched: string[];
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
) => Promise<{
  role: string;
  reason?: string | undefined;
  /**
   * How certain the classifier is, 0..1. Optional, and omitted by
   * `makeLLMClassifier`: a parsed JSON blob carries no certainty, so the only
   * honest answer there is "no number", which keeps the historical
   * `confidence: 1`.
   *
   * A classifier that CAN measure its certainty — one answering with a
   * probability distribution rather than prose — reports it here, so a near-tie
   * between two siblings reaches `DispatchResult.confidence` as the near-tie it
   * is instead of as certainty.
   */
  confidence?: number | undefined;
} | null>;

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

/** Suffix → replacement, first match wins; the stem left must keep 3+ chars. */
const STEM_RULES: readonly (readonly [string, string])[] = [
  ['ifications', 'ify'],
  ['ification', 'ify'],
  ['ations', 'ate'],
  ['ation', 'ate'],
  ['ings', ''],
  ['ing', ''],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ier', 'y'],
  // No agentive `-er`: it would fold the role noun "writer" into every "write".
  ['ed', ''],
  ['es', ''],
  ['s', ''],
];

/**
 * A deliberately light stemmer, applied to the task and to every keyword alike
 * so both sides land on the same form: "tests"/"testing" → "test",
 * "translations"/"translate" → "translat", "verification"/"verify" → "verify".
 * Without it a keyword matched only its exact spelling, and "add translations"
 * scored nothing against the i18n role's "translation".
 */
export function stemDispatchWord(word: string): string {
  let stem = word;
  if (stem.length > 3 && !/(?:ss|us|is|eed)$/.test(stem)) {
    for (const [suffix, replacement] of STEM_RULES) {
      if (!stem.endsWith(suffix)) continue;
      const base = stem.slice(0, -suffix.length);
      if (base.length + replacement.length < 3) continue;
      stem = base + replacement;
      break;
    }
  }
  return stem.length >= 4 && stem.endsWith('e') ? stem.slice(0, -1) : stem;
}

function dispatchWords(text: string): string[] {
  return normalize(text).split(/\s+/).filter(Boolean).map(stemDispatchWord);
}

/**
 * Score every agent against the task. A keyword hit adds 1 point; an n-word
 * keyword phrase adds 2n-1 (more specific = stronger signal than the same words
 * matched separately). Returns candidates sorted best-first, zero-score agents
 * dropped.
 *
 * Keywords that reduce to the same words count once. Role definitions spread a
 * shared `signals` list and then repeat its entries (`'android'`, `'ipc'`), and
 * spelling variants (`end-to-end` / `end to end`) normalize together; counted
 * per entry, those 26 roles scored every hit twice and won ties they had no
 * claim to — "explore how the mailbox IPC works" went to `desktop`.
 */
export function scoreAgents(
  task: string,
  catalog: Record<string, AgentDefinition> = AGENT_CATALOG,
): DispatchCandidate[] {
  // Tokenize once — O(task words) — then do O(1) set lookups per keyword
  const haySet = new Set(dispatchWords(task));
  const out: DispatchCandidate[] = [];
  for (const def of Object.values(catalog)) {
    if (!def?.config?.role) continue;
    const hits: { kw: string; words: string[] }[] = [];
    const counted = new Set<string>();
    for (const kw of def.capability.keywords) {
      const needleWords = dispatchWords(kw);
      const key = needleWords.join(' ');
      if (!key || counted.has(key)) continue;
      counted.add(key);
      // Check if all words in the keyword phrase are present in the task
      if (needleWords.every((w) => haySet.has(w))) hits.push({ kw, words: needleWords });
    }
    // Longest phrases first; a hit whose words a longer hit of the same role
    // already covered adds nothing — "test" inside "write tests" is one
    // signal, not two.
    hits.sort((a, b) => b.words.length - a.words.length);
    let score = 0;
    const matched: string[] = [];
    const covered = new Set<string>();
    for (const hit of hits) {
      if (hit.words.every((w) => covered.has(w))) continue;
      for (const w of hit.words) covered.add(w);
      // A phrase outscores the same words matched loose: "sql injection" is a
      // stronger signal than "sql" and "injection" scattered across a role's
      // list, so an n-word phrase scores 2n-1.
      score += hit.words.length * 2 - 1;
      matched.push(hit.kw);
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
      matched: top.matched,
      alternatives: candidates.slice(1, maxCandidates),
    };
  }

  // Ambiguous or no signal — ask the classifier if one is wired.
  if (opts.classifier) {
    // Offer the classifier the top heuristic candidates — but only when the
    // heuristic actually produced a choice to make.
    //
    // We are here BECAUSE the heuristic was inconclusive, so a pool built from
    // it is inconclusive too, and a pool of ONE is not a choice at all: the
    // classifier can only rubber-stamp it. That is not hypothetical. On this
    // catalog, "design how we should store and rotate the signing keys" scores
    // exactly one keyword hit — `designer`, the UI role, on the word "design"
    // — and "the CI job times out only on windows" scores exactly one, on
    // "ci". Handing over a single name turned the classifier into a formality
    // and sent key management to the UI designer.
    //
    // Below two candidates, offer the whole catalog instead. One Choice holds
    // a roster this size comfortably, and it is the only way the classifier
    // can see the role the keywords missed.
    const pool = (
      candidates.length > 1
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
          // A classifier that measured its certainty reports it; one that
          // could not keeps the historical 1.
          confidence: choice.confidence ?? 1,
          method: 'llm',
          reason: choice.reason ?? 'Selected by LLM classifier',
          matched: candidates.find((c) => c.role === choice.role)?.matched ?? [],
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
      matched: top.matched,
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
    matched: [],
    alternatives: [],
  };
}

/**
 * The dispatch catalog for a live roster: built-in roles keep their catalog
 * definition, project roles are synthesised from their `dispatch` metadata.
 * Shared by every leader spawn tool so `delegate` and `spawn_subagent` route
 * the same text to the same role.
 */
export function rosterDispatchCatalog(
  roster: Record<string, SubagentConfig>,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(roster).map(([role, config]) => {
      const builtIn = getAgentDefinition(role);
      if (builtIn) return [role, builtIn];
      return [
        role,
        {
          config,
          budget: {
            timeoutMs: config.timeoutMs,
            maxIterations: config.maxIterations,
            maxToolCalls: config.maxToolCalls,
            maxTokens: config.maxTokens,
            maxCostUsd: config.maxCostUsd,
          },
          capability: {
            phase: 'meta',
            summary: config.dispatch?.summary ?? config.prompt ?? config.name,
            keywords: config.dispatch?.keywords ?? [],
          },
        } satisfies AgentDefinition,
      ];
    }),
  );
}

/** Lifecycle order the role menu is rendered in; `other` holds roles outside the catalog. */
const MENU_PHASE_ORDER: readonly (AgentPhase | 'other')[] = [
  'discovery',
  'planning',
  'build',
  'domain',
  'verify',
  'review',
  'delivery',
  'knowledge',
  'meta',
  'other',
];

/**
 * The roster as the leader's system prompt lists it: role ids grouped by
 * lifecycle phase, one line per phase.
 *
 * Ids only, on purpose. With summaries the menu is ~8k chars on every leader
 * request; grouped ids are ~1k, and the leader does not need to recall an id
 * at all — omitting `role` routes the task through `dispatchAgent`, which
 * reads the full capability metadata.
 */
export function rosterRoleMenu(roster: Record<string, SubagentConfig>): string {
  const groups = new Map<string, string[]>();
  for (const role of Object.keys(roster)) {
    const phase = getAgentDefinition(role)?.capability.phase ?? 'other';
    const ids = groups.get(phase) ?? [];
    ids.push(role);
    groups.set(phase, ids);
  }
  return MENU_PHASE_ORDER.filter((phase) => groups.has(phase))
    .map((phase) => `- ${phase}: ${(groups.get(phase) ?? []).join(', ')}`)
    .join('\n');
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
