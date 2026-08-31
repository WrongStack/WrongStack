/**
 * Bounded-concurrency async map.
 *
 * Runs `fn` over `items` with at most `limit` in-flight promises. Order of
 * results matches input order. Errors reject the returned promise on the first
 * failure — the remaining in-flight work is not awaited; this matches
 * `Promise.all` semantics for callers that want fail-fast behavior.
 *
 * Lives here (rather than imported from `@wrongstack/bench`) because:
 *   1. tools sits below bench in the dependency graph — bench is a consumer of
 *      tools, never the other way around.
 *   2. The semantics used by grep/glob are deliberately simple (fail-fast,
 *      no cancellation, no progress) and don't need bench's richer options.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (items.length === 1) return [await fn(items[0] as T)];
  const effectiveLimit = Math.max(1, Math.min(limit | 0, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, worker));
  return results;
}
