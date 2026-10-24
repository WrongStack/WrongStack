/**
 * Output-token caps a provider has REPORTED for a model (issue #398).
 *
 * The models.dev catalog's `limit.output` is what `resolveMaxOutputTokens`
 * sends as `max_tokens`, and it can be wrong for one provider's deployment of
 * a model: models.dev lists `ollama-cloud/deepseek-v4-pro` at 1048576 while
 * ollama.com rejects anything above 65536 — every request failed with a 400.
 * That 400 names the real cap, so the number is learned from the provider
 * itself, never invented: the provider runner records it and retries once,
 * and the output resolver clamps to it from then on (for this process).
 *
 * Keyed by the runtime provider id (the config key, as `Provider.id` and
 * `BuildBodyContext.providerId` carry it) and the exact model id.
 */

/**
 * Provider phrasings that state the model's maximum output tokens, each
 * capturing that number. Taken from real error bodies:
 * - Ollama (issue #398): `max_tokens (1048576) exceeds model's maximum output
 *   tokens (65536) for model deepseek-v4-pro`
 * - OpenAI Chat Completions: `max_tokens is too large: 32768. This model
 *   supports at most 4096 completion tokens, whereas you provided 32768.`
 * - Anthropic Messages: `max_tokens: 1000000 > 64000, which is the maximum
 *   allowed number of output tokens for claude-sonnet-4-20250514`
 */
const REPORTED_MAX_OUTPUT_PATTERNS: readonly RegExp[] = [
  /exceeds (?:the )?model'?s maximum output tokens \((\d+)\)/i,
  /supports at most (\d+) completion tokens/i,
  /max_tokens:\s*\d+\s*>\s*(\d+),\s*which is the maximum allowed number of output tokens/i,
];

/** The maximum output tokens a provider error text states, or `undefined`. */
export function parseProviderReportedMaxOutput(text: string | undefined): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  for (const pattern of REPORTED_MAX_OUTPUT_PATTERNS) {
    const match = pattern.exec(text);
    const value = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

const reportedCaps = new Map<string, number>();

function capKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * Remember the cap a provider reported for a model. Returns `true` when this
 * lowered (or first set) the cap — i.e. a retry would now send a different
 * value — and `false` when an equal or lower cap was already known, so a
 * caller can never loop on the same rejection.
 */
export function recordProviderReportedMaxOutput(
  providerId: string | undefined,
  modelId: string | undefined,
  cap: number,
): boolean {
  if (!providerId || !modelId || !Number.isSafeInteger(cap) || cap <= 0) return false;
  const key = capKey(providerId, modelId);
  const known = reportedCaps.get(key);
  if (known !== undefined && known <= cap) return false;
  reportedCaps.set(key, cap);
  return true;
}

/** The cap the provider reported for this model in this process, if any. */
export function providerReportedMaxOutput(
  providerId: string | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!providerId || !modelId) return undefined;
  return reportedCaps.get(capKey(providerId, modelId));
}

/** Test seam: forget every reported cap. */
export function clearProviderReportedMaxOutputs(): void {
  reportedCaps.clear();
}
