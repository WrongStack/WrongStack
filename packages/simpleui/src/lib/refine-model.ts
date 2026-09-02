/** Refine (prompt enhance) projection.
 *
 * Wire contract, shared with the WebUI and served by the same CLI
 * webui-server: `model.refine` { text, timeoutMs?, provider?, model?,
 * previousRefined?, previousEnglish?, retryFeedback? }
 * answers with `model.refine_result` { refined, english, error?, errorKind?,
 * retryTimeoutMs?, fallbackRef?, refinedWith? }.
 *
 * This module owns the decision of what a result means so the component
 * stays a renderer and the behaviour is unit-testable.
 */

export type RefineDecision = 'refined' | 'english' | 'original' | 'edit';

export type RefineStatus = 'countdown' | 'refining' | 'ready' | 'failed';

export type RefineErrorKind = 'timeout' | 'empty' | 'provider_error';

export interface RefineState {
  original: string;
  refined: string;
  english: string;
  status: RefineStatus;
  error?: string | undefined;
  errorKind?: RefineErrorKind | undefined;
  /** One-key "retry on another model" offer resolved by the server. */
  fallbackRef?: string | undefined;
  /** True once the automatic post-timeout retry has been spent. */
  retried?: boolean | undefined;
  /** Provider id of the model running the refinement (e.g. "openai"). */
  provider?: string | undefined;
  /** Model name running the refinement (e.g. "gpt-4o"). */
  model?: string | undefined;
  /** Monotonically increasing epoch counter used to detect stale
   *  `model.refine_result` messages that arrived after the user flushed
   *  the panel and started a new refine round-trip. */
  epoch?: number | undefined;
  /** Images attached to the original message. Forwarded on flush so
   *  image attachments are not silently dropped when a pending refine
   *  is superseded by a new send. */
  images?: { data: string; mime: string }[] | undefined;
}

export interface RefineResultPayload {
  refined?: unknown;
  english?: unknown;
  error?: unknown;
  errorKind?: unknown;
  retryTimeoutMs?: unknown;
  fallbackRef?: unknown;
  refinedWith?: unknown;
}

/** What the app should do with a `model.refine_result`. */
export type RefineAction =
  /** Timeout on the first attempt — re-request with the server's longer window. */
  | { kind: 'retry'; timeoutMs: number; state: RefineState }
  /** The refinement is a no-op; skip the panel and send the original. */
  | { kind: 'send'; text: string }
  /** Show the panel (comparison when ready, recovery when failed). */
  | { kind: 'panel'; state: RefineState };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorKind(value: unknown): RefineErrorKind | undefined {
  return value === 'timeout' || value === 'empty' || value === 'provider_error' ? value : undefined;
}

/** Compare ignoring whitespace/case noise — a refinement that only reflows
 *  the text is not worth a review round-trip. */
export function normalizedEqual(a: string, b: string): boolean {
  return (
    a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()
  );
}

export function projectRefineResult(
  payload: RefineResultPayload,
  current: RefineState,
): RefineAction {
  const error = text(payload.error);
  if (error) {
    const kind = errorKind(payload.errorKind);
    const retryTimeoutMs =
      typeof payload.retryTimeoutMs === 'number' && payload.retryTimeoutMs > 0
        ? payload.retryTimeoutMs
        : 0;
    // A timeout means the model was reachable but slow, so spend one silent
    // retry on the longer window the server suggests. Anything else — or a
    // second timeout — surfaces the recovery panel and lets the user decide
    // rather than silently sending the unrefined original.
    if (kind === 'timeout' && !current.retried && retryTimeoutMs) {
      return {
        kind: 'retry',
        timeoutMs: retryTimeoutMs,
        state: { ...current, status: 'refining', retried: true },
      };
    }
    return {
      kind: 'panel',
      state: {
        ...current,
        status: 'failed',
        error,
        errorKind: kind,
        fallbackRef: text(payload.fallbackRef) || undefined,
      },
    };
  }

  const refined = text(payload.refined);
  if (!refined || normalizedEqual(refined, current.original)) {
    return { kind: 'send', text: current.original };
  }
  const refinedWith =
    payload.refinedWith && typeof payload.refinedWith === 'object'
      ? (payload.refinedWith as Record<string, unknown>)
      : undefined;
  return {
    kind: 'panel',
    state: {
      ...current,
      status: 'ready',
      refined,
      english: text(payload.english) || refined,
      ...(refinedWith && text(refinedWith['provider']) && text(refinedWith['model'])
        ? { provider: text(refinedWith['provider']), model: text(refinedWith['model']) }
        : {}),
      // Clear any stale failure from a prior retry round.
      error: undefined,
      errorKind: undefined,
    },
  };
}

/** Split a server `fallbackRef` into its provider and model.
 *
 *  Refs are `provider/model` and split on the FIRST slash only — a model id
 *  may itself contain slashes (`openrouter/anthropic/claude-3`). */
export function parseFallbackRef(ref: string): { provider: string; model: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0) return null;
  const provider = ref.slice(0, slash).trim();
  const model = ref.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}

/** Resolve what Escape should restore into the composer when it closes the
 *  refine panel.
 *
 *  The composer was cleared when the send started, so the original text
 *  would otherwise be lost. But if the user already typed something new
 *  after the panel opened, that in-progress draft wins — returning `null`
 *  means "leave the composer untouched". */
export function resolveEscapeRestore(
  state: RefineState | null,
  currentDraft: string,
): string | null {
  if (!state) return null;
  if (currentDraft.trim()) return null;
  return state.original || null;
}

/** Resolve which text a panel decision sends. */
export function resolveRefineText(state: RefineState, decision: RefineDecision): string | null {
  switch (decision) {
    case 'refined':
      return state.refined;
    case 'english':
      return state.english;
    case 'original':
      return state.original;
    default:
      return null;
  }
}
