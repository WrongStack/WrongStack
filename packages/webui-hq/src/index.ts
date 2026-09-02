/**
 * @wrongstack/webui-hq — HQ Command Center dashboard.
 *
 * Offline React app served by the HQ server (port 3499). No CDN dependencies.
 * Build with `vite build` -> `dist/`. The HQ server serves `dist/index.html`
 * at `/` and falls back to a diagnostic-only recovery document when the assets
 * are missing — see `packages/cli/src/hq-static-serve.ts`.
 */
export { AppShell } from './components/hq/app-shell.js';
export { getHqSocket, HqSocket } from './data/transport/hq-socket.js';
export { useHqStore } from './data/store/index.js';
