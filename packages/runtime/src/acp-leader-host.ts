/**
 * `@wrongstack/runtime/acp-leader-host` — the ACP leader's process-wide host
 * binding alone: the provider id, bind/unbind, the per-session agent lookup and
 * closing every live leader session on the way out. It imports no runtime code
 * (types only), so the CLI can load it on every exit without pulling in
 * `@wrongstack/acp`, `@wrongstack/fleet` or `@wrongstack/mcp`. The binding is
 * shared with `@wrongstack/runtime/acp-leader` (see acp-leader-host.ts).
 */
export * from './acp-leader/acp-leader-host.js';
