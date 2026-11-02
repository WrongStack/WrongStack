/**
 * Token usage of one provider request, in its own leaf module so token
 * counters and session records can name it without importing the provider
 * contract (which reaches tools and the agent context). `provider.ts`
 * re-exports it unchanged.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  /** Back-compat aggregate of all cache-write tokens. Prefer TTL-specific fields when present. */
  cacheWrite?: number | undefined;
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
}
