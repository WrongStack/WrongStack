import type { ReasoningEffort, Request } from '@wrongstack/core/types';

/**
 * OpenAI's Chat Completions API accepts `reasoning_effort` only for these
 * values. `minimal`, `xhigh`, and `max` are broader WrongStack-internal
 * effort levels that get mapped down or filtered out here — sending an
 * unrecognized value would cause a 400.
 *
 * Single source of truth for the Chat Completions allowlist: import this
 * instead of redefining it locally (the OpenAI preset used to carry a private
 * copy that drifted from this one).
 */
export const OPENAI_EFFORT_VALUES = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high']);

export function isOpenAIEffort(effort: ReasoningEffort): boolean {
  return OPENAI_EFFORT_VALUES.has(effort);
}

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
