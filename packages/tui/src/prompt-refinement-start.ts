interface MutableSlot<T> {
  current: T;
}

interface StartPromptRefinementOptions<T> {
  original: string;
  controller: AbortController;
  originalSlot: MutableSlot<string>;
  abortSlot: MutableSlot<AbortController | null>;
  setStartedAt: (startedAt: number) => void;
  setBusy: (on: boolean) => void;
  clearDraft: () => void;
  prepareContext: () => Promise<T>;
  fallbackContext: T;
  now?: () => number;
}

/**
 * Enter the visible refiner state synchronously, then perform optional async
 * context preparation. Nothing in `prepareContext` may delay acknowledgement
 * of the user's submit.
 */
export async function startPromptRefinement<T>(
  options: StartPromptRefinementOptions<T>,
): Promise<T> {
  options.originalSlot.current = options.original;
  options.setStartedAt((options.now ?? Date.now)());
  options.setBusy(true);
  options.clearDraft();
  options.abortSlot.current = options.controller;

  if (options.controller.signal.aborted) return options.fallbackContext;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((resolve) => {
    onAbort = () => resolve(options.fallbackContext);
    options.controller.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    // Context providers do not all accept an AbortSignal. Racing them keeps
    // Esc responsive even when an underlying memory/index lookup is stuck.
    return await Promise.race([options.prepareContext(), aborted]);
  } catch {
    // Memory/index context is optional. Refinement itself can continue using
    // the active conversation and provider when enrichment is unavailable.
    return options.fallbackContext;
  } finally {
    if (onAbort) options.controller.signal.removeEventListener('abort', onAbort);
  }
}
