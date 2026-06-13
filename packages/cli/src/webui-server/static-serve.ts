import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { createHttpServer } from '@wrongstack/webui/server';

/**
 * PR 6 of Issue #30 (webui-server 8-PR refactor):
 * dist discovery + HTTP server bring-up.
 *
 * Before this PR, the `runWebUI` body inlined five lines
 * that resolved the webui package's `dist` directory via
 * `createRequire(import.meta.url)` and handed the path to
 * `createHttpServer`. If the webui package wasn't built,
 * the inline try/catch silently degraded to WS-only.
 *
 * After this PR, the dist-resolution lives in
 * `webui-server/static-serve.ts` and the only thing
 * `runWebUI` does is call `startStaticServe({ host,
 * httpPort, wsPort, globalRoot })`. The function returns
 * the listening `Server` and its real `port` (the OS
 * may reassign if the requested port was in use), or
 * `null` when the webui package is unbuilt.
 *
 * The try/catch around the require resolution stays
 * inside this module so the runWebUI body does not have
 * to think about webui's build state at all.
 */

export interface StaticServeHandle {
  server: Server;
  port: number;
}

export interface StaticServeOptions {
  host: string;
  httpPort: number;
  wsPort: number;
  globalRoot: string;
}

export function startStaticServe(opts: StaticServeOptions): StaticServeHandle | null {
  let distDir: string;
  try {
    const requireFromHere = createRequire(import.meta.url);
    const serverEntry = requireFromHere.resolve('@wrongstack/webui/server');
    distDir = path.resolve(path.dirname(serverEntry), '..'); // .../dist
  } catch {
    return null;
  }

  const server = createHttpServer({
    host: opts.host,
    distDir,
    wsPort: opts.wsPort,
    globalRoot: opts.globalRoot,
  });

  server.listen(opts.httpPort, opts.host);
  // `createHttpServer` returns the bound port via
  // `server.address()` after `listen` resolves. We return
  // the requested port instead because the existing
  // call sites pass the requested port straight into
  // the open-browser URL — the runWebUI body has no
  // use for the bound-port value today. If a future
  // caller needs the actual bound port, this function
  // is the place to expose it (e.g. via a `listening`
  // event).
  return { server, port: opts.httpPort };
}
