import type { CodeMapGraphResponse } from './codemap-model';

export const EMPTY_GRAPH: CodeMapGraphResponse = { nodes: [], edges: [] };

/** Hide MiniMap when the canvas is dense; it re-paints every node update. */
export const MINIMAP_NODE_LIMIT = 48;
/** Virtualize search hits above this count. */
export const SEARCH_VIRTUALIZE_THRESHOLD = 40;
/** Max animated SVG edges (live + trail). Animated paths are expensive. */
export const MAX_ANIMATED_EDGES = 6;
/** Cap how many agents contribute temporal trail edges. */
export const MAX_TRAIL_AGENTS = 4;
/** Cap hops per agent trail (N activities -> N-1 edges). */
export const MAX_TRAIL_HOPS = 6;
/** Telemetry-only React Flow rebuilds are coalesced to this cadence. */
export const FLOW_ACTIVITY_THROTTLE_MS = 120;
/** Concurrent symbol-graph fetches for unresolved live tool ops. */
export const MAX_SYMBOL_RESOLVE_INFLIGHT = 2;
/** Soft cap on client-side scope graphs (package/file/symbol). */
export const MAX_CLIENT_GRAPH_CACHE = 48;
/** Debounce free-text search so typing does not re-scan every cached graph. */
export const SEARCH_DEBOUNCE_MS = 150;
