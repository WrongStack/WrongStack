import type { ReasoningEffort, Request } from '@wrongstack/contracts/types';

/**
 * EXHAUSTIVE acceptance table for the Chat Completions `reasoning_effort`
 * field. Every canonical {@link ReasoningEffort} must be classified here — a
 * new core level without a row is a COMPILE ERROR, not a silent drop.
 *
 * Single source of truth for the Chat Completions vocabulary: `openai.ts`
 * (first-party, via {@link shouldEmitReasoningEffort}) and `presets/openai.ts`
 * (Copilot, via {@link isOpenAIEffort}) both gate through this table. The
 * previous shape — a hand-listed `Set` whose `.has()` returned `false` for
 * anything unlisted — is precisely how the A2/A3 divergence happened: a new
 * level quietly fell through every allowlist at once.
 */
export const OPENAI_EFFORT_ACCEPT: Readonly<Record<ReasoningEffort, boolean>> = {
  none: true,
  // `minimal` (gpt-5) and `xhigh` (the gpt-5.2 tier) ARE Chat Completions
  // values. Dropping them made the user's pick a silent no-op — the same fault
  // the Responses adapter fixed by passing every level verbatim. A model that
  // does not take the level answers 400 naming the field; the adapter then
  // retries without it and remembers (`effort-support.ts`), so a wrong guess
  // costs one request instead of every request being wrong.
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  // `max` is WrongStack's own top level with no Chat Completions spelling.
  max: false,
};

export function isOpenAIEffort(effort: ReasoningEffort): boolean {
  return OPENAI_EFFORT_ACCEPT[effort];
}

/**
 * Fallback mapping for GENERIC OpenAI-compatible gateways: what to send when
 * the base builder drops a value — i.e. for every level where
 * {@link OPENAI_EFFORT_ACCEPT} is `false`.
 *
 * INVARIANT (pinned by `tests/effort-vocabulary.test.ts`):
 *   GENERIC_EFFORT_FALLBACK[e] === undefined  ⟺  OPENAI_EFFORT_ACCEPT[e] === true
 * and every defined fallback is itself an accepted value (`low`/`high`).
 *
 * The old implementation encoded the left half of that invariant in a
 * `switch` whose `default:` branch silently swallowed any unclassified level
 * — the A3 half of the divergence (low/medium/high dropped while
 * minimal/xhigh/max survived as mapped extremes). The exhaustive table makes
 * the coupling explicit and compile-checked: adding a level to the union
 * without classifying it in BOTH tables fails the build.
 */
export const GENERIC_EFFORT_FALLBACK: Readonly<
  Record<ReasoningEffort, 'low' | 'high' | 'xhigh' | undefined>
> = {
  // Base builder emits these verbatim — no fallback, no double-write.
  none: undefined,
  minimal: undefined,
  low: undefined,
  medium: undefined,
  high: undefined,
  xhigh: undefined,
  // The one level with no wire spelling — collapse onto the nearest real value.
  max: 'xhigh',
};

/**
 * Decide whether the wire body should carry `reasoning_effort` for this request.
 *
 * Value gate only. The former tools suppression — "some Chat Completions
 * gateways reject the field whenever function tools are present" — was
 * observed on third-party gateways (some LiteLLM / omniroute deployments),
 * never on OpenAI's first-party endpoint, whose docs confirm effort works
 * alongside tool use. Applying it here silently dropped `reasoning_effort`
 * from virtually every agentic request the agent loop sends.
 *
 * The tools-based suppression lives on only where the observation came from:
 * `applyGenericReasoningEffort` in the OpenAI-compatible adapter (generic
 * gateways with no provider-specific policy). Provider-specific adapters with
 * an explicit model allowlist (for example OpenCode Go) keep restoring
 * supported values after that conservative gate runs.
 */
export function shouldEmitReasoningEffort(req: Request): boolean {
  const effort = req.reasoning?.effort;
  if (effort === undefined) return false;
  return isOpenAIEffort(effort);
}

/**
 * Map key for one streamed `delta.tool_calls[]` entry. `index` is the wire's
 * key, but some OpenAI-compatible endpoints omit it and send each parallel
 * call whole, under its own `id`. Defaulting every such delta to 0 appended
 * call #2's arguments to call #1 (unparseable JSON) and dropped call #2.
 */
export function streamedToolCallIndex(
  byIndex: ReadonlyMap<number, { id?: string | undefined }>,
  toolCall: { index?: number | undefined; id?: string | undefined },
): number {
  if (typeof toolCall.index === 'number') return toolCall.index;
  let last = -1;
  for (const [key, entry] of byIndex) {
    if (toolCall.id && entry.id === toolCall.id) return key;
    if (key > last) last = key;
  }
  if (last === -1) return 0;
  // No id continues the latest call; so does the first id of a call that
  // started without one.
  if (!toolCall.id || !byIndex.get(last)?.id) return last;
  return last + 1;
}
