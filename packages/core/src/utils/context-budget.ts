/**
 * Session meta key holding the tokens a prepared request carries beyond the
 * durable transcript (wire-only blocks plus any pre-send overflow still being
 * rescued). Compaction subtracts it from the input budget so it targets the
 * request that is actually sent, not just the history.
 */
export const CONTEXT_REQUEST_OVERHEAD_META = 'contextRequestOverheadTokens';

/** Value stored under {@link CONTEXT_REQUEST_OVERHEAD_META}; bound to one provider/model route. */
export interface ContextRequestOverhead {
  routeKey: string;
  tokens: number;
}

export interface ContextWindowBudgetInput {
  maxContext: number;
  inputTokens: number;
  maxOutput?: number | undefined;
  outputReserveTokens?: number | undefined;
  safetyBufferTokens?: number | undefined;
  /**
   * Tokens the request pipeline adds on the wire beyond what the caller
   * measured (injected system blocks, tools, wire-only messages). They occupy
   * the window too, so they shrink the room left for the measured input.
   */
  requestOverheadTokens?: number | undefined;
}

export interface ContextWindowBudgetSnapshot {
  maxContext: number;
  inputTokens: number;
  availableInputTokens: number;
  remainingInputTokens: number;
  reservedOutputTokens: number;
  reservedSafetyTokens: number;
  load: number;
  overflowTokens: number;
}

/**
 * Reserve at most min(8192, 8% of the window), not the model's theoretical
 * output ceiling. A genuinely smaller output ceiling can reduce the reserve.
 */
export function defaultContextOutputReserve(maxContext: number, maxOutput?: number): number {
  const safeMax = Number.isFinite(maxContext) && maxContext > 0 ? maxContext : 0;
  const heuristic = Math.floor(Math.min(8192, safeMax * 0.08));
  if (typeof maxOutput === 'number' && Number.isFinite(maxOutput) && maxOutput > 0) {
    return Math.min(heuristic, Math.floor(maxOutput));
  }
  return heuristic;
}

/** Pure budget arithmetic; callers supply validated, whole-token reserve overrides. */
export function computeContextWindowBudget({
  maxContext,
  inputTokens,
  maxOutput,
  outputReserveTokens,
  safetyBufferTokens,
  requestOverheadTokens,
}: ContextWindowBudgetInput): ContextWindowBudgetSnapshot {
  const safeMaxContext = Number.isFinite(maxContext) && maxContext > 0 ? maxContext : 1;
  const safeInputTokens = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  const reservedOutputTokens =
    typeof outputReserveTokens === 'number' &&
    Number.isFinite(outputReserveTokens) &&
    outputReserveTokens >= 0
      ? Math.floor(outputReserveTokens)
      : defaultContextOutputReserve(safeMaxContext, maxOutput);
  const reservedSafetyTokens =
    typeof safetyBufferTokens === 'number' &&
    Number.isFinite(safetyBufferTokens) &&
    safetyBufferTokens >= 0
      ? Math.floor(safetyBufferTokens)
      : Math.floor(Math.min(4096, safeMaxContext * 0.02));
  const overhead =
    typeof requestOverheadTokens === 'number' &&
    Number.isFinite(requestOverheadTokens) &&
    requestOverheadTokens > 0
      ? Math.floor(requestOverheadTokens)
      : 0;
  const baseInputTokens = safeMaxContext - reservedOutputTokens - reservedSafetyTokens;
  // Overhead that fills the whole window on its own is not something history
  // compaction can make room for; the pre-send check reports that case.
  const availableInputTokens = Math.max(
    1,
    overhead < baseInputTokens ? baseInputTokens - overhead : baseInputTokens,
  );
  const remainingInputTokens = availableInputTokens - safeInputTokens;
  return {
    maxContext: safeMaxContext,
    inputTokens: safeInputTokens,
    availableInputTokens,
    remainingInputTokens,
    reservedOutputTokens,
    reservedSafetyTokens,
    load: safeInputTokens / availableInputTokens,
    overflowTokens: Math.max(0, -remainingInputTokens),
  };
}
