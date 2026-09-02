import type { ContentBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { MemoryEntry, MemoryScope, MemoryStore } from '../types/memory.js';
import type {
  Provider,
  ReasoningConfig,
  ReasoningEffort,
  ReasoningRequest,
  Request,
} from '../types/provider.js';
import { toErrorMessage } from '../utils/error.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';

/**
 * Prompt refinement ("did you mean this?").
 *
 * Runs a one-shot LLM call in a SEPARATE context (its own system prompt, no
 * conversation history, no tools) that rewrites a raw user message into a
 * clearer, more complete instruction BEFORE the main agent sees it. The goal
 * is to make the main context start from a well-understood request rather than
 * guessing intent from terse input like "fix the bug".
 *
 * This mirrors `IntelligentCompactor.callSummarizer` — a plain
 * `provider.complete()` with a dedicated system prompt — and is deliberately
 * free of React / TUI dependencies so it can be unit-tested in isolation.
 */

export const ENHANCER_SYSTEM_PROMPT = readBundledInstructionText('llm/prompt-enhancer.md');

/** Words/phrases that are control answers, not refinable requests. */
const AFFIRMATION_RE =
  /^(y|n|yes|no|yep|nope|ok|okay|sure|go|go ahead|continue|proceed|stop|cancel|done|next|skip|retry|again|please do|do it)\b[.! ]*$/i;

/**
 * Heuristic gate: should this raw input be sent through the refiner at all?
 * Pure + exported for unit testing. Returns false for inputs where refinement
 * is pointless or unwanted (slash commands, one-word affirmations, trivially
 * short text, bare numbers).
 */
export function shouldEnhance(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('/')) return false; // slash command
  if (t.length < 12) return false; // too short to be worth refining
  if (AFFIRMATION_RE.test(t)) return false; // "yes" / "continue" / ...
  if (/^[\d\s.,]+$/.test(t)) return false; // bare numbers (menu picks, etc.)
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false; // 1–2 words rarely benefit
  return true;
}

/**
 * Preference order when picking an effort level: the cheapest level that still
 * does SOME reasoning first ('low', then 'minimal'), then up the ladder, with
 * fully-off ('none') last so it's only chosen when it's the sole advertised
 * option. This keeps the refiner cheap without dropping reasoning entirely when
 * a little still helps. 'low' leads because it's the most widely accepted low
 * level across adapters (e.g. OpenAI's reasoning_effort set).
 */
const EFFORT_PREFERENCE: ReasoningEffort[] = [
  'low',
  'minimal',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
];

/**
 * Build a reasoning directive for the refiner that minimizes wasted thinking,
 * gated to what the model actually accepts. Refinement is a shallow rewrite
 * task — extended thinking adds latency and (hidden) token cost for little
 * gain — so we ask the model to spend as little reasoning as it safely can.
 *
 * The gating mirrors `resolveReasoningForRequest` so we never send a field the
 * model would reject:
 *   - effort-capable model      → its lowest advertised effort level;
 *   - else disable-capable model → disable thinking (`enabled: false`);
 *   - else (always-on / unknown) → `undefined` (leave the provider default).
 *
 * Returns `undefined` whenever nothing can be safely reduced. Callers forward
 * that verbatim to `enhanceUserPrompt`, which then sends no reasoning field —
 * identical to the behavior before this hint existed. Pure + exported for unit
 * testing.
 */
export function gatedEnhancerReasoning(
  rc: ReasoningConfig | undefined,
): ReasoningRequest | undefined {
  // Capabilities unknown → don't risk an unsupported field (matches the
  // conservative "capabilities unknown" branch in resolveReasoningForRequest).
  if (!rc) return undefined;
  if (rc.effortSupported && rc.effortLevels.length > 0) {
    const lowest = EFFORT_PREFERENCE.find((e) => rc.effortLevels.includes(e)) ?? rc.effortLevels[0];
    if (lowest) return { effort: lowest };
  }
  if (rc.disableSupported) return { enabled: false };
  return undefined;
}

/**
 * Normalize for "did the refiner actually change anything?" comparison —
 * collapse whitespace and lowercase so trivial reformatting doesn't trigger
 * the confirmation panel.
 */
export function normalizedEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

// Deliberately narrow prompt-domain lexicons, not a general language detector.
// Unknown text is rejected so the model gets one corrective pass rather than
// allowing an unverified English label through.
const ENGLISH_PROMPT_WORDS = new Set([
  'a',
  'add',
  'analyze',
  'and',
  'api',
  'as',
  'build',
  'change',
  'check',
  'code',
  'configure',
  'create',
  'delete',
  'document',
  'ensure',
  'error',
  'explain',
  'failure',
  'feature',
  'file',
  'fix',
  'for',
  'from',
  'function',
  'implement',
  'improve',
  'in',
  'into',
  'is',
  'issue',
  'it',
  'keep',
  'make',
  'model',
  'of',
  'only',
  'output',
  'parser',
  'preserve',
  'prompt',
  'race',
  'refactor',
  'remove',
  'request',
  'resolve',
  'response',
  'return',
  'run',
  'should',
  'test',
  'that',
  'the',
  'this',
  'to',
  'translate',
  'update',
  'use',
  'validate',
  'version',
  'when',
  'with',
  'write',
  'condition',
]);

const NON_ENGLISH_PROMPT_WORDS = new Set([
  // Turkish
  'ama',
  'bir',
  'bu',
  'de',
  'düzelt',
  'et',
  'hata',
  'hatasını',
  'hatayı',
  'için',
  'ile',
  'olarak',
  'sadece',
  've',
  'yap',
  'şu',
  // Spanish / Portuguese
  'con',
  'corrige',
  'debe',
  'el',
  'en',
  'erro',
  'la',
  'para',
  'que',
  'sin',
  'una',
  // French
  'avec',
  'dans',
  'des',
  'doit',
  'erreur',
  'et',
  'le',
  'les',
  'pour',
  'sans',
  'une',
  // German
  'das',
  'den',
  'der',
  'die',
  'ein',
  'fehler',
  'für',
  'mit',
  'ohne',
  'und',
]);

function languageWords(text: string): string[] {
  // Normalize Turkish capital dotted İ before lowercasing; generic/English
  // locale lowercasing otherwise leaves a combining dot that splits words.
  return (
    text
      .replaceAll('İ', 'i')
      .toLowerCase()
      .match(/\p{L}+/gu) ?? []
  );
}

function hasNonLatinScript(text: string): boolean {
  return /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    text,
  );
}

function languageScores(text: string): { english: number; nonEnglish: number; words: string[] } {
  const words = languageWords(text);
  let english = 0;
  let nonEnglish = 0;
  for (const word of words) {
    if (ENGLISH_PROMPT_WORDS.has(word)) english++;
    if (NON_ENGLISH_PROMPT_WORDS.has(word)) nonEnglish++;
  }
  // Inspect the original text before languageWords() normalizes dotted İ;
  // these Turkish-specific characters are meaningful non-English evidence.
  if (/[çğıöşüİı]/u.test(text)) nonEnglish += 2;
  if (hasNonLatinScript(text)) nonEnglish += 3;
  return { english, nonEnglish, words };
}

/**
 * Conservative validation for the English half of a bilingual refinement.
 * It requires explicit English instruction vocabulary and rejects every known
 * non-English marker; identifiers and file paths alone are not language proof.
 */
export function isValidEnglishRefinement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const scores = languageScores(trimmed);
  return scores.nonEnglish === 0 && scores.english > 0;
}

type LatestMessageLanguage = 'english' | 'non_english' | 'unknown';

const VIBE_TAG_PATTERN = /\[vibe\]/iu;

function preserveVibeTag(original: string, candidate: string): string {
  if (!VIBE_TAG_PATTERN.test(original) || VIBE_TAG_PATTERN.test(candidate)) return candidate;
  return `[VIBE] ${candidate}`;
}

function latestMessageLanguage(text: string): LatestMessageLanguage {
  const scores = languageScores(text);
  if (scores.nonEnglish > scores.english) return 'non_english';
  if (scores.english > scores.nonEnglish) return 'english';
  return 'unknown';
}

/**
 * Parse and validate the two-version wire format emitted by the refiner.
 * Visually blank separator padding (ASCII/non-breaking/zero-width whitespace)
 * and CRLF are tolerated, but exactly one separator and two non-empty versions
 * are required. The second version must be English.
 */
export function parseBilingualEnhancement(raw: string, original: string): EnhanceResult | null {
  const separator = /^[\t \u00a0\u200b-\u200d\ufeff]*---[\t \u00a0\u200b-\u200d\ufeff]*\r?$/gm;
  const matches = [...raw.matchAll(separator)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (!match) return null;
  const rawRefined = raw.slice(0, match.index).trim();
  const rawEnglish = raw.slice(match.index + match[0].length).trim();
  if (!rawRefined || !rawEnglish) return null;
  const refined = preserveVibeTag(original, rawRefined);
  const english = preserveVibeTag(original, rawEnglish);
  if (!isValidEnglishRefinement(english)) return null;

  // Reject a clearly English first half when the original was non-English.
  // For lexically ambiguous input, require the model to make the first half
  // classifiable; otherwise two unchecked halves could bypass correction.
  const inputLanguage = latestMessageLanguage(original);
  const refinedLanguage = latestMessageLanguage(refined);
  if (inputLanguage === 'non_english' && refinedLanguage === 'english') return null;
  if (inputLanguage === 'unknown' && refinedLanguage === 'unknown') return null;
  return { refined, english };
}

/** A single text-only conversation turn used as refiner context. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Additional context the refiner may use to resolve references. */
export interface RefinerContextSection {
  title: string;
  items: string[];
}

/**
 * Minimal structural shape of the live agent context needed to enrich the
 * refiner. Kept structural so browser/client bundles do not need the Context
 * class and tests can pass plain objects.
 */
export interface RefinerSessionContextLike {
  projectRoot?: unknown;
  cwd?: unknown;
  workingDir?: unknown;
  readFiles?: unknown;
  writtenFiles?: unknown;
  todos?: unknown;
}

/**
 * Result of a successful prompt refinement. Carries the original-language and
 * validated English versions so the UI can offer both. English input still
 * uses the two-part wire contract; both fields may contain identical text.
 */
export interface EnhanceResult {
  /** Refined in the user's original language. */
  refined: string;
  /** Refined in English. Equals `refined` when the input was already English. */
  english: string;
}

/**
 * Why a refine attempt fell through. Callers use this to decide the recovery
 * path: `timeout` is a transient capacity/latency failure worth an automatic
 * retry with a longer window (the model was reachable, just slow); `empty` and
 * `provider_error` mean the attempt produced nothing useful, so the caller
 * should surface the recovery options (retry, switch model, send as-is) rather
 * than silently retry. User-initiated cancellation is NOT reported here (it
 * returns `null` with no `onError` call).
 */
export type EnhanceFailureKind = 'timeout' | 'empty' | 'provider_error';

export const DEFAULT_REFINER_RETRY_FEEDBACK =
  'Make another pass that is sharper and more self-contained. Use the provided project memory, current session context, and recent conversation only to resolve references and preserve project vocabulary; keep the original scope unchanged.';

export interface EnhanceUserPromptOptions {
  provider: Provider;
  model: string;
  text: string;
  /**
   * Recent conversation turns (oldest→newest), text only, used purely as
   * CONTEXT so the refiner can resolve references in a follow-up message
   * ("it", "the same", "that file"). Without this, the refiner is blind to
   * the conversation and can only refine self-contained prompts. Build with
   * `recentTextTurns(ctx.messages)`.
   */
  history?: ConversationTurn[] | undefined;
  /**
   * Project/session context snippets, already filtered and compacted by the
   * caller. They are context only: the refiner may use them to resolve
   * references, names, files, conventions, and constraints, but must not turn
   * them into extra requirements.
   */
  contextSections?: RefinerContextSection[] | undefined;
  /** Previous refinement when the user asks for another pass. */
  previousRefinement?: EnhanceResult | undefined;
  /** Short instruction for a retry pass. Defaults to `DEFAULT_REFINER_RETRY_FEEDBACK`. */
  retryFeedback?: string | undefined;
  /** Parent abort signal (e.g. the run controller / Esc). */
  signal?: AbortSignal | undefined;
  /** Hard cap on how long to wait for the refiner before giving up. Default 90s. */
  timeoutMs?: number | undefined;
  /** Max tokens for the refined output. Default 2048. */
  maxTokens?: number | undefined;
  /**
   * Reasoning directive for the refiner call. Refinement is a shallow
   * restate-this-more-clearly task that does not benefit from extended
   * thinking, so callers pass a low-effort / thinking-disabled hint here to
   * cut latency and (hidden) reasoning-token cost — most impactful on slow
   * reasoning models. Build it with `gatedEnhancerReasoning(rc)` so the field
   * is gated to what the model accepts. Omit (undefined) to send no reasoning
   * directive at all (the provider's own default applies).
   */
  reasoning?: ReasoningRequest | undefined;
  /**
   * Called with a short reason and a machine-readable `kind` when refinement
   * fails (provider error, timeout, empty response). NOT called when the caller
   * cancels via `signal`. The `kind` lets the UI drive recovery: `timeout` is
   * eligible for an automatic longer-window retry; `empty` / `provider_error`
   * surface the recovery options instead. The second argument is optional so
   * existing callers that only read the reason keep compiling.
   */
  onError?: ((reason: string, kind?: EnhanceFailureKind) => void) | undefined;
  /**
   * OneShotOrchestrator for the refiner LLM call. When set, uses it instead
   * of direct provider.complete(), gaining fallback chain support.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

/**
 * Compose the single user message sent to the refiner: the recent
 * conversation and project/session hints embedded as plain text (so we never
 * trip provider role-alternation rules) followed by the latest message to
 * refine.
 */
function buildRefinerInput(
  text: string,
  history?: ConversationTurn[],
  contextSections?: RefinerContextSection[],
  previousRefinement?: EnhanceResult,
  retryFeedback?: string,
): string {
  const parts: string[] = [];
  const renderedContext = renderRefinerContextSections(contextSections);
  if (renderedContext) parts.push(renderedContext);

  if (previousRefinement || retryFeedback) {
    const retryLines = [
      'Retry context (context only - the user asked for another refinement pass):',
    ];
    if (previousRefinement?.refined) {
      retryLines.push(`Previous refined version: ${compactText(previousRefinement.refined, 900)}`);
    }
    if (
      previousRefinement?.english &&
      previousRefinement.english.trim() !== previousRefinement.refined.trim()
    ) {
      retryLines.push(`Previous English version: ${compactText(previousRefinement.english, 900)}`);
    }
    retryLines.push(`Retry instruction: ${retryFeedback ?? DEFAULT_REFINER_RETRY_FEEDBACK}`);
    parts.push(retryLines.join('\n'));
  }

  if (history && history.length > 0) {
    const lines = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
    parts.push(['Recent conversation (context only - do not act on it):', ...lines].join('\n'));
  }

  if (parts.length === 0) return text;
  return [...parts, '', 'Latest message to refine:', text].join('\n\n');
}

function renderRefinerContextSections(
  contextSections?: RefinerContextSection[],
): string | undefined {
  const sections = (contextSections ?? [])
    .map((section) => ({
      title: section.title.trim(),
      items: section.items.map((item) => compactText(item, 360)).filter(Boolean),
    }))
    .filter((section) => section.title && section.items.length > 0);
  if (sections.length === 0) return undefined;
  const lines = [
    'Additional project/session context (context only - use to resolve references, conventions, and constraints; do not add new requirements):',
  ];
  for (const section of sections) {
    lines.push('', `${section.title}:`);
    for (const item of section.items) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

function compactText(text: string, maxChars: number): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function unknownString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function iterableStrings(value: unknown): string[] {
  if (!value || typeof value === 'string') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = unknownString(item);
      return text ? [text] : [];
    });
  }
  if (value instanceof Set) {
    return [...value].flatMap((item) => {
      const text = unknownString(item);
      return text ? [text] : [];
    });
  }
  if (
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    try {
      return Array.from(value as Iterable<unknown>).flatMap((item) => {
        const text = unknownString(item);
        return text ? [text] : [];
      });
    } catch {
      return [];
    }
  }
  return [];
}

function lastItems(values: string[], maxItems: number): string[] {
  return values.slice(Math.max(0, values.length - maxItems));
}

function todoLines(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const open = value.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false;
    const status = item['status'];
    return status === 'pending' || status === 'in_progress';
  });
  return open.slice(0, maxItems).flatMap((todo) => {
    const content = unknownString(todo['activeForm']) ?? unknownString(todo['content']);
    if (!content) return [];
    return [`open todo (${String(todo['status'])}): ${compactText(content, 220)}`];
  });
}

function buildRefinerSessionContextSection(
  context?: RefinerSessionContextLike,
): RefinerContextSection | undefined {
  if (!context) return undefined;
  const items: string[] = [];
  const projectRoot = unknownString(context.projectRoot);
  const workingDir = unknownString(context.workingDir) ?? unknownString(context.cwd);
  if (projectRoot) items.push(`project root: ${projectRoot}`);
  if (workingDir && workingDir !== projectRoot) items.push(`working dir: ${workingDir}`);

  for (const file of lastItems(iterableStrings(context.readFiles), 6)) {
    items.push(`recently read file: ${file}`);
  }
  for (const file of lastItems(iterableStrings(context.writtenFiles), 6)) {
    items.push(`recently written file: ${file}`);
  }
  items.push(...todoLines(context.todos, 6));
  return items.length > 0 ? { title: 'Current session state', items } : undefined;
}

function formatMemoryEntry(entry: MemoryEntry): string {
  const meta = [entry.scope, entry.type, entry.priority].filter(Boolean).join('/');
  const tags =
    entry.tags && entry.tags.length > 0 ? ` tags: ${entry.tags.slice(0, 5).join(', ')}` : '';
  return `${meta ? `[${meta}] ` : ''}${compactText(entry.text, 260)}${tags}`;
}

async function collectMemoryEntries(
  memoryStore: MemoryStore,
  text: string,
  scope: MemoryScope,
  limit: number,
): Promise<MemoryEntry[]> {
  const scored = memoryStore.scoreRelevant
    ? await memoryStore
        .scoreRelevant({ currentTask: text }, scope, limit)
        .catch(() => [] as MemoryEntry[])
    : [];
  if (scored.length > 0) return scored;
  return memoryStore.search(text || 'prompt refinement', scope, limit).catch(() => []);
}

async function buildRefinerMemoryContextSection(
  memoryStore: MemoryStore | undefined,
  text: string,
): Promise<RefinerContextSection | undefined> {
  if (!memoryStore) return undefined;
  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const scope of ['project-memory', 'user-memory'] as const) {
    const remaining = Math.max(0, 6 - entries.length);
    if (remaining === 0) break;
    for (const entry of await collectMemoryEntries(memoryStore, text.trim(), scope, remaining)) {
      const key = `${entry.scope}:${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      if (entries.length >= 6) break;
    }
  }
  if (entries.length === 0) return undefined;
  return { title: 'Relevant project memory', items: entries.map(formatMemoryEntry) };
}

export async function buildRefinerContextSections(opts: {
  text: string;
  memoryStore?: MemoryStore | undefined;
  context?: RefinerSessionContextLike | undefined;
}): Promise<RefinerContextSection[]> {
  const sections: RefinerContextSection[] = [];
  const memory = await buildRefinerMemoryContextSection(opts.memoryStore, opts.text);
  if (memory) sections.push(memory);
  const session = buildRefinerSessionContextSection(opts.context);
  if (session) sections.push(session);
  return sections;
}

/**
 * Refine a raw user prompt. Returns the refined text, or `null` when the
 * caller should fall back to the original (refiner errored, timed out, was
 * aborted, or returned nothing useful). NEVER throws — refinement is a
 * best-effort convenience and must never block the user from sending.
 */
export interface RefinerCompletionOptions {
  provider: Provider;
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
  request: Request;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Execute one refiner pass through either the orchestrator or direct provider. */
export async function completeRefinerPass(
  input: string,
  opts: RefinerCompletionOptions,
): Promise<{ text: string; error?: string | undefined }> {
  if (opts.oneShotOrchestrator) {
    const result = await opts.oneShotOrchestrator.call({
      system: ENHANCER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
      maxTokens: opts.request.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return result.error ? { text: '', error: result.error } : { text: result.text.trim() };
  }
  const response = await opts.provider.complete(
    { ...opts.request, messages: [{ role: 'user', content: input }] },
    { signal: opts.signal },
  );
  return {
    text: response.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n')
      .trim(),
  };
}

export async function enhanceUserPrompt(
  opts: EnhanceUserPromptOptions,
): Promise<EnhanceResult | null> {
  const { provider, model, text } = opts;
  // Reasoning models ("thinking" models like DeepSeek reasoner / o1) take
  // longer to first token, so give a generous default window.
  const timeoutMs = opts.timeoutMs ?? 90000;
  // Generous default: on some endpoints the model's hidden "thinking" tokens
  // count against this budget, so a small cap can leave NO room for the actual
  // refined text (→ empty completion → null). 2048 keeps the output room ample.
  const maxTokens = opts.maxTokens ?? 2048;
  const refinerInput = buildRefinerInput(
    text,
    opts.history,
    opts.contextSections,
    opts.previousRefinement,
    opts.retryFeedback,
  );

  const req: Request = {
    model,
    system: [{ type: 'text', text: ENHANCER_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: refinerInput }],
    maxTokens,
    // NOTE: deliberately NO `temperature`. The main agent loop never sets it,
    // and reasoning models (DeepSeek reasoner, o1/o3, …) return HTTP 400 when
    // `temperature` is present — which would make every refine call fail and
    // silently fall back to the original (no panel shown).
    //
    // A reasoning hint is forwarded ONLY when the caller supplies one (it must
    // already be gated to the model's advertised support — see
    // `gatedEnhancerReasoning`). Absent it, no reasoning field is sent, which
    // is identical to the original behavior.
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
  };

  let timedOut = false;
  const runPass = async (input: string): Promise<{ text: string; error?: string | undefined }> => {
    // Each model pass receives the full configured window. The parent signal
    // still cancels both passes immediately, while a slow first pass cannot
    // consume the corrective retry's entire timeout budget.
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new Error('enhancer timeout')), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
    try {
      return await completeRefinerPass(input, {
        provider,
        oneShotOrchestrator: opts.oneShotOrchestrator,
        request: req,
        signal,
        timeoutMs,
      });
    } catch (error) {
      if (timer.signal.aborted && !opts.signal?.aborted) timedOut = true;
      throw error;
    } finally {
      timer.abort();
      clearTimeout(timeout);
    }
  };

  try {
    const first = await runPass(refinerInput);
    if (first.error) {
      opts.onError?.(first.error, 'provider_error');
      return null;
    }
    const parsed = parseBilingualEnhancement(first.text, text);
    if (parsed) return parsed;

    // The output contract is deliberately validated outside the model. Give a
    // malformed response one corrective pass, with the failure and exact wire
    // format made explicit, instead of silently treating non-English text as
    // the English option.
    const correctionInput = [
      'Your previous response did not satisfy the required bilingual output contract.',
      'Return exactly two non-empty versions separated by one line containing only "---".',
      'The first version must match the language of the latest message. The second version must be English.',
      'Do not add labels, headings, fences, commentary, or additional separators.',
      '',
      `Latest message to refine:\n${text}`,
      '',
      `Invalid previous response:\n${compactText(first.text || '(empty response)', 1800)}`,
    ].join('\n');
    const corrected = await runPass(correctionInput);
    if (corrected.error) {
      opts.onError?.(corrected.error, 'provider_error');
      return null;
    }
    const correctedParsed = parseBilingualEnhancement(corrected.text, text);
    if (correctedParsed) return correctedParsed;

    opts.onError?.('model returned malformed bilingual output after one corrective retry', 'empty');
    return null;
  } catch (err) {
    // User-initiated cancel → stay silent (they chose to send the original).
    if (opts.signal?.aborted) return null;
    if (timedOut) {
      opts.onError?.(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      return null;
    }
    opts.onError?.(toErrorMessage(err), 'provider_error');
    return null;
  }
}

/** Pull the visible text out of a message's content (ignores tool blocks). */
function messageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Extract the last few user/assistant TEXT turns from a conversation, newest
 * last, for use as refiner context. Skips system messages and tool-only turns
 * (tool_use / tool_result carry no useful natural-language context and bloat
 * the call). Each turn is truncated to `maxChars`; at most `maxTurns` are
 * returned. Pure + exported for unit testing.
 */
export function recentTextTurns(
  messages: Message[],
  maxTurns = 6,
  maxChars = 1500,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = messageText(m.content);
    if (!text) continue;
    turns.unshift({
      role: m.role,
      text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text,
    });
  }
  return turns;
}
