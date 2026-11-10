/**
 * `@wrongstack/runtime/acp-leader-host` — the ACP leader's process-wide host
 * binding alone: the provider id, bind/unbind, the per-session agent lookup and
 * closing every live leader session on the way out, plus the remote-work
 * registry a leader's WrongForge task holds the exit with. It imports nothing
 * heavy, so the CLI can load it on every exit without pulling in
 * `@wrongstack/acp`, `@wrongstack/fleet` or `@wrongstack/mcp`. Both are
 * shared through `globalThis` with `@wrongstack/runtime/acp-leader` and
 * `@wrongstack/runtime/wrongforge-leader`.
 */
export * from './acp-leader/acp-leader-host.js';
export { deferShutdownForRemoteWork, drainRemoteWork } from './acp-leader/remote-work.js';
