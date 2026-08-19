import type { ReasoningEffort, Request } from '@wrongstack/core/types';

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
  minimal: false,
  low: true,
  medium: true,
  high: true,
  xhigh: false,
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
  Record<ReasoningEffort, 'low' | 'high' | undefined>
> = {
  // Base builder emits these verbatim — no fallback, no double-write.
  none: undefined,
  low: undefined,
  medium: undefined,
  high: undefined,
  // Base builder drops these — collapse onto the nearest accepted extreme.
  minimal: 'low',
  xhigh: 'high',
  max: 'high',
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
