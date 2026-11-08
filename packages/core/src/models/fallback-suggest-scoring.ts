/**
 * Fallback profile suggestions — turns the models the user can actually reach
 * (keyed providers × their catalog) into ready-made fallback chains such as
 * "strong", "balanced", "fast" and "budget".
 *
 * Two stages, both pure:
 *
 *   1. {@link suggestFallbackProfiles} — deterministic scoring from catalog
 *      facts (price, reasoning, release date, context window) plus family
 *      name hints (`opus`/`pro` vs `mini`/`flash`). Never calls a model, so it
 *      always produces an answer, including offline.
 *   2. {@link buildFallbackSuggestPrompt} + {@link mergeLlmFallbackSuggestions}
 *      — an optional LLM pass that re-ranks the SAME candidate pool using what
 *      the model knows about benchmark standing and agentic reliability. The
 *      LLM may only reorder refs it was shown: an unknown ref drops the whole
 *      LLM profile back to the heuristic one, so a hallucinated model id can
 *      never reach config.
 *
 * Price is a strength proxy only among PAID models. Subscription and local
 * providers often report 0 or no price at all; those fall back to name hints,
 * reasoning and recency instead of being read as "weakest" (see the unknown-
 * price rule in coordination/model-tier.ts — unknown skips a signal, it never
 * zeroes it).
 */

/** One reachable model, as the WebUI `provider.models` projection carries it. */
export interface FallbackSuggestCandidate {
  /** Saved provider id (the auth profile alias, e.g. `openai`, `custom-2`). */
  provider: string;
  model: string;
  name?: string | undefined;
  /** ISO date (`2025-05-14`) or year-month. */
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  /** USD per 1M input tokens. */
  inputCost?: number | undefined;
  /** USD per 1M output tokens. */
  outputCost?: number | undefined;
  /** `tools`, `reasoning`, `vision`, ... — empty/absent means undocumented. */
  capabilities?: readonly string[] | undefined;
  /** models.dev lifecycle marker: `deprecated` is dropped, `beta` is demoted. */
  status?: string | undefined;
  /** models.dev version line (`minimax`, `glm`, `claude-opus`) — see `dropSuperseded`. */
  family?: string | undefined;
}

export const FALLBACK_SUGGESTION_IDS = ['strong', 'balanced', 'fast', 'budget'] as const;

export type FallbackSuggestionId = (typeof FALLBACK_SUGGESTION_IDS)[number];

export interface SuggestFallbackOptions {
  /** Models per chain (clamped 2..6). Default 4. */
  chainLength?: number | undefined;
  /**
   * Drop models released more than this many months before the NEWEST model
   * in the pool. Default {@link DEFAULT_MAX_AGE_MONTHS}; 0 disables.
   */
  maxAgeMonths?: number | undefined;
  /** Restrict the output to these archetypes, in this order. */
  ids?: readonly FallbackSuggestionId[] | undefined;
}

export interface ScoredFallbackCandidate {
  candidate: FallbackSuggestCandidate;
  ref: string;
  /** Provider-local family line (see `familyLine`) — one per chain. */
  line: string;
  strength: number;
  speed: number;
  cheapness: number;
  reasoning: boolean;
  /** Beta / preview / free-tier promo: works, but a poor bet for a fallback. */
  unstable: boolean;
}

/**
 * Suggestions are only as good as they are current: a chain built today must
 * not fall back to last year's generation just because it is still listed.
 * Measured against the newest model in the user's OWN pool, not the wall
 * clock — a stale catalog cache must not empty the suggestions.
 */
export const DEFAULT_MAX_AGE_MONTHS = 6;

/** Below this context window a model cannot hold an agent turn. */
export const MIN_CONTEXT_WINDOW = 16_000;

/**
 * Ids that are not chat/agent models even when a catalog lists them under a
 * chat provider: embeddings, speech, image generation, moderation, rerankers.
 */
export const NON_AGENT_MODEL =
  /(embed|tts|whisper|transcri|speech|moderation|dall-?e|imagen|rerank|realtime|(^|[-_/.])image([-_.]|$)|(^|[-_/.])audio([-_.]|$))/i;

/**
 * Family size hints, matched as WHOLE id tokens: a substring test reads the
 * `MiniMax-M2` brand as both "mini" and "max". Lighter hints win over heavier
 * ones, so `o4-mini` is light even though `o4` alone is heavy.
 */
export const ULTRA_LIGHT_TOKENS = new Set(['nano', 'tiny', 'lite', 'micro']);

export const LIGHT_TOKENS = new Set(['mini', 'flash', 'haiku', 'small', 'instant', 'air', 'spark']);

/**
 * Same model, faster serving (`glm-5.3-highspeed`, `grok-code-fast-1`): a speed
 * signal that must NOT also mark the model as weaker.
 */
export const SPEED_ONLY_TOKENS = new Set(['highspeed', 'fast', 'turbo', 'speed', 'lightning']);

export const UNSTABLE_TOKENS = new Set(['preview', 'exp', 'experimental', 'beta', 'alpha', 'free']);

export const HEAVY_TOKENS = new Set([
  'opus',
  'pro',
  'max',
  'ultra',
  'large',
  'o1',
  'o3',
  'thinking',
  'reasoner',
  'r1',
  'plus',
]);

export type SizeHint = 'ultralight' | 'light' | 'neutral' | 'heavy';

export function idTokens(id: string): string[] {
  return id.toLowerCase().split(/[-_/.:@\s]+/u);
}

export function sizeHint(id: string): SizeHint {
  const tokens = idTokens(id);
  let params: number | undefined;
  for (const token of tokens) {
    // `a3b` / `a22b` are MoE ACTIVE params — total size is the other token.
    const m = /^(\d+(?:\.\d+)?)b$/u.exec(token);
    if (m) params = Math.max(params ?? 0, Number(m[1]));
  }
  if (tokens.some((t) => ULTRA_LIGHT_TOKENS.has(t)) || (params !== undefined && params <= 4)) {
    return 'ultralight';
  }
  if (tokens.some((t) => LIGHT_TOKENS.has(t)) || (params !== undefined && params <= 32)) {
    return 'light';
  }
  if (tokens.some((t) => HEAVY_TOKENS.has(t)) || (params !== undefined && params >= 200)) {
    return 'heavy';
  }
  return 'neutral';
}

export const HINT_STRENGTH: Record<SizeHint, number> = {
  ultralight: 0,
  light: 0.2,
  neutral: 0.55,
  heavy: 1,
};

export const HINT_SPEED: Record<SizeHint, number> = {
  ultralight: 1,
  light: 0.85,
  neutral: 0.5,
  heavy: 0.15,
};

export function formatFallbackRef(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Blended $/1M with agent traffic in mind: input-heavy (history re-sent every
 * turn), output smaller. Undefined when the catalog prices neither side.
 */
export function blendedPrice(c: FallbackSuggestCandidate): number | undefined {
  const input = finiteOrUndefined(c.inputCost);
  const output = finiteOrUndefined(c.outputCost);
  if (input === undefined && output === undefined) return undefined;
  if (input === undefined) return output;
  if (output === undefined) return input;
  return (3 * input + output) / 4;
}

export function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function releaseTime(c: FallbackSuggestCandidate): number | undefined {
  if (!c.releaseDate) return undefined;
  const t = Date.parse(c.releaseDate.length === 7 ? `${c.releaseDate}-01` : c.releaseDate);
  return Number.isFinite(t) ? t : undefined;
}

/** Fraction of `sorted` strictly below `value`, tie-adjusted, in 0..1. */
export function percentile(sorted: readonly number[], value: number): number {
  if (sorted.length <= 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
}

export function weightedMean(parts: Array<[value: number | undefined, weight: number]>): number {
  let sum = 0;
  let weight = 0;
  for (const [value, w] of parts) {
    if (value === undefined) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0.5;
}

/** True when the model can plausibly drive an agent turn (tools + context). */
export function isFallbackEligible(c: FallbackSuggestCandidate): boolean {
  if (c.status === 'deprecated') return false;
  if (NON_AGENT_MODEL.test(c.model)) return false;
  const caps = c.capabilities ?? [];
  // Undocumented capabilities stay eligible (custom/local providers); a
  // catalog that documents capabilities WITHOUT tools rules the model out.
  if (caps.length > 0 && !caps.includes('tools')) return false;
  if (typeof c.contextWindow === 'number' && c.contextWindow > 0) {
    if (c.contextWindow < MIN_CONTEXT_WINDOW) return false;
  }
  return true;
}

/** Score every eligible candidate. Exported for the LLM pool and for tests. */
export function scoreFallbackCandidates(
  candidates: readonly FallbackSuggestCandidate[],
  options: Pick<SuggestFallbackOptions, 'maxAgeMonths'> = {},
): ScoredFallbackCandidate[] {
  const seen = new Set<string>();
  const unique: FallbackSuggestCandidate[] = [];
  for (const c of candidates) {
    if (!c.provider || !c.model || !isFallbackEligible(c)) continue;
    const ref = formatFallbackRef(c.provider, c.model);
    if (seen.has(ref)) continue;
    seen.add(ref);
    unique.push(c);
  }
  const eligible = dropOutdated(unique, options.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS);

  const paidPrices = eligible
    .map(blendedPrice)
    .filter((p): p is number => p !== undefined && p > 0)
    .sort((a, b) => a - b);
  const releases = eligible
    .map(releaseTime)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b);
  const contexts = eligible
    .map((c) => c.contextWindow)
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);

  return eligible.map((c) => {
    const hint = sizeHint(c.model);
    const tokens = idTokens(c.model);
    const speedOnly = tokens.some((t) => SPEED_ONLY_TOKENS.has(t));
    const unstable = isUnstable(c);
    const caps = c.capabilities ?? [];
    const reasoning = caps.includes('reasoning');
    const price = blendedPrice(c);
    const pricePct = price !== undefined && price > 0 ? percentile(paidPrices, price) : undefined;
    const release = releaseTime(c);
    const recencyPct = release !== undefined ? percentile(releases, release) : undefined;
    const contextPct =
      typeof c.contextWindow === 'number' && c.contextWindow > 0
        ? percentile(contexts, c.contextWindow)
        : undefined;

    const strength = weightedMean([
      [pricePct, 0.35],
      [HINT_STRENGTH[hint], 0.3],
      [caps.length > 0 ? (reasoning ? 1 : 0) : undefined, 0.15],
      [recencyPct, 0.15],
      [contextPct, 0.05],
    ]);
    const speed = clamp01(
      weightedMean([
        [speedOnly ? Math.max(HINT_SPEED[hint], 0.85) : HINT_SPEED[hint], 0.7],
        [pricePct !== undefined ? 1 - pricePct : undefined, 0.3],
      ]) - (reasoning && hint !== 'light' && hint !== 'ultralight' ? 0.1 : 0),
    );
    const cheapness = price === undefined ? 0.5 : price === 0 ? 1 : 1 - (pricePct ?? 0.5);

    return {
      candidate: c,
      ref: formatFallbackRef(c.provider, c.model),
      line: familyLine(c),
      strength: round3(strength),
      speed: round3(speed),
      cheapness: round3(cheapness),
      reasoning,
      unstable,
    };
  });
}

/**
 * Two currency rules, applied before any scoring:
 *
 *  1. Superseded versions go. Within one provider and one models.dev
 *     `family` (`minimax`, `glm`, `claude-opus`), only the highest version
 *     survives: `MiniMax-M3` retires `MiniMax-M2.7` AND `MiniMax-M2.7-highspeed`,
 *     `glm-5.3` retires `glm-5.2`. A newer version that exists only as a
 *     preview/beta does not retire the stable one — both stay, and the
 *     unstable one is demoted at scoring time.
 *  2. Stale models go: released more than `maxAgeMonths` before the newest
 *     dated model in the pool (the pool, not the wall clock — a stale catalog
 *     cache must not empty the suggestions).
 *
 * Models with no parseable version or no date are kept by the respective
 * rule: an unknown is not evidence of age.
 */
export function dropOutdated(
  pool: readonly FallbackSuggestCandidate[],
  maxAgeMonths: number,
): FallbackSuggestCandidate[] {
  const current = dropSuperseded(pool);
  if (!(maxAgeMonths > 0)) return current;
  let newest: number | undefined;
  for (const c of current) {
    const t = releaseTime(c);
    if (t !== undefined && (newest === undefined || t > newest)) newest = t;
  }
  if (newest === undefined) return current;
  const cutoff = new Date(newest);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - maxAgeMonths);
  const cutoffTime = cutoff.getTime();
  return current.filter((c) => {
    const t = releaseTime(c);
    return t === undefined || t >= cutoffTime;
  });
}

export function dropSuperseded(
  pool: readonly FallbackSuggestCandidate[],
): FallbackSuggestCandidate[] {
  // Highest STABLE version per version line; unstable versions only count
  // when the line has no stable release at all.
  const best = new Map<string, { version: number[]; stable: boolean }>();
  for (const c of pool) {
    const version = modelVersion(c.model);
    if (!version) continue;
    const line = versionLine(c);
    const stable = !isUnstable(c);
    const prev = best.get(line);
    if (
      !prev ||
      (stable && !prev.stable) ||
      (stable === prev.stable && compareVersions(version, prev.version) > 0)
    ) {
      best.set(line, { version, stable });
    }
  }
  const sameLine = pool.filter((c) => {
    const version = modelVersion(c.model);
    const top = version ? best.get(versionLine(c)) : undefined;
    if (!version || !top) return true;
    const cmp = compareVersions(version, top.version);
    // Same version (variants: -highspeed, -flash) stays; a NEWER unstable
    // version stays beside the stable one; everything older goes.
    return cmp === 0 || (cmp > 0 && isUnstable(c));
  });
  return dropPreviousGenerations(sameLine);
}

/** A previous major generation must also be this much older to be dropped. */
export const GENERATION_GAP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * models.dev splits one vendor's lineup into several families (`gpt-sol`,
 * `gpt-luna`, `gpt-pro`), so the family rule alone kept `gpt-5.5-pro` next
 * to the provider's gpt-6 models. Across a provider's models of ONE vendor
 * (`gpt`, `claude`, `qwen`, `glm`), a stable model whose MAJOR version is
 * below the newest stable generation's — and that was released at least
 * {@link GENERATION_GAP_MS} before it — is a previous generation and goes.
 * The date gap keeps vendors whose product lines number independently from
 * losing a line released alongside the new generation.
 */
export function dropPreviousGenerations(
  pool: readonly FallbackSuggestCandidate[],
): FallbackSuggestCandidate[] {
  const newest = new Map<string, { major: number; released: number }>();
  for (const c of pool) {
    const version = modelVersion(c.model);
    const released = releaseTime(c);
    if (!version || released === undefined || isUnstable(c)) continue;
    const key = vendorKey(c);
    const major = version[0] as number;
    const prev = newest.get(key);
    if (!prev || major > prev.major || (major === prev.major && released > prev.released)) {
      newest.set(key, { major, released });
    }
  }
  return pool.filter((c) => {
    const version = modelVersion(c.model);
    const released = releaseTime(c);
    const top = newest.get(vendorKey(c));
    if (!version || released === undefined || !top) return true;
    return (version[0] as number) >= top.major || top.released - released < GENERATION_GAP_MS;
  });
}

/** Provider + vendor: the first word of the models.dev family, else of the id. */
export function vendorKey(c: FallbackSuggestCandidate): string {
  const source = c.family?.trim() || c.model;
  const vendor =
    source
      .toLowerCase()
      .split(/[-_/.:@\s]+/u)[0]
      ?.replace(/\d+$/u, '') ?? '';
  return `${c.provider}\u0000v:${vendor}`;
}

/** Provider + models.dev family; id-derived stem when the catalog has none. */
export function versionLine(c: FallbackSuggestCandidate): string {
  const family = c.family?.trim().toLowerCase();
  return family ? `${c.provider}\u0000f:${family}` : familyLine(c);
}

export function isUnstable(c: FallbackSuggestCandidate): boolean {
  return c.status === 'beta' || idTokens(c.model).some((t) => UNSTABLE_TOKENS.has(t));
}

/**
 * Release version from an id: `MiniMax-M3.1-Flash` → [3,1], `glm-5.3` →
 * [5,3], `claude-opus-5-5` → [5,5], `deepseek-v4-pro-0813` → [4]. Snapshot
 * dates (`0813`, `20250929`) and parameter sizes (`30b`, `a3b`) are not
 * versions and are skipped.
 */
export function modelVersion(model: string): number[] | undefined {
  const tokens = model
    .toLowerCase()
    .split(/[-_/:@\s]+/u)
    .filter((t) => t.length > 0 && !/\d{4,}/u.test(t) && !/^a?\d+(\.\d+)?b$/u.test(t));
  for (let i = 0; i < tokens.length; i++) {
    const m = /(\d+(?:\.\d+)*)/u.exec(tokens[i] as string);
    if (!m) continue;
    const parts = (m[1] as string).split('.').map(Number);
    // `claude-opus-5-5`: a bare major followed by a bare 1-2 digit minor.
    const next = tokens[i + 1];
    if (
      parts.length === 1 &&
      /^\d+$/u.test(tokens[i] as string) &&
      next &&
      /^\d{1,2}$/u.test(next)
    ) {
      parts.push(Number(next));
    }
    return parts;
  }
  return undefined;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Provider + id with every digit and lifecycle suffix removed — the "line" a
 * model belongs to across versions: `qwen3.8-max` and `qwen3.7-max` share
 * `qwen-max`, while `qwen3.8-flash` is a different line.
 */
export function familyLine(c: FallbackSuggestCandidate): string {
  const stem = idTokens(c.model)
    .map((t) => t.replace(/\d+/gu, ''))
    .filter((t) => t.length > 0 && !LIFECYCLE_TOKENS.has(t))
    .join('-');
  return `${c.provider}\u0000${stem}`;
}

export const LIFECYCLE_TOKENS = new Set([
  'latest',
  'preview',
  'exp',
  'experimental',
  'beta',
  'alpha',
]);

export function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
