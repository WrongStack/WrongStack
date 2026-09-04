export interface ContextWindowBudgetInput {
  maxContext: number;
  inputTokens: number;
  maxOutput?: number | undefined;
  outputReserveTokens?: number | undefined;
  safetyBufferTokens?: number | undefined;
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
  const heuristic = Math.floor(Math.min(8192, maxContext * 0.08));
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
}: ContextWindowBudgetInput): ContextWindowBudgetSnapshot {
  const reservedOutputTokens =
    outputReserveTokens ?? defaultContextOutputReserve(maxContext, maxOutput);
  const reservedSafetyTokens = safetyBufferTokens ?? Math.floor(Math.min(4096, maxContext * 0.02));
  const availableInputTokens = Math.max(1, maxContext - reservedOutputTokens - reservedSafetyTokens);
  const remainingInputTokens = availableInputTokens - inputTokens;
  return {
    maxContext,
    inputTokens,
    availableInputTokens,
    remainingInputTokens,
    reservedOutputTokens,
    reservedSafetyTokens,
    load: inputTokens / availableInputTokens,
    overflowTokens: Math.max(0, -remainingInputTokens),
  };
}
