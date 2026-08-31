/**
 * Default per-call transport timeout (ms) shared by every request surface in
 * this adapter. `httpJson` (client.ts) and `createMcpTransport` (mcp.ts) both
 * default their per-call bound to this single value, so a slow daemon can
 * never add latency surprises to the edit path (see the hooks.ts failure
 * philosophy: coordination is an optimization, never a hard dependency).
 *
 * One source of truth instead of mirroring literals that can drift apart —
 * tuning the ceiling once adjusts every transport surface.
 */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 4_000;