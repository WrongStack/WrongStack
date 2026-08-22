/**
 * @wrongstack/webui-server — public API entry.
 *
 * The WebUI HTTP/WebSocket server module, extracted from @wrongstack/webui in
 * PR #018b (see docs/backlog/2026-07-architecture-review/018-modularity-audit-and-plan.md
 * §3.1.1). This re-export surface exists so consumers can `import { ... }
 * from '@wrongstack/webui-server'` without reaching into ./server/...
 * internals.
 *
 * The implementation lives in `./server/` — `./server/index.ts` is the
 * canonical barrel. Consumers (CLI, future cross-package code) should
 * import from this file (the package root) for forward-compat.
 */

export * from '@wrongstack/webui-protocol';
export * from './server/index.js';
