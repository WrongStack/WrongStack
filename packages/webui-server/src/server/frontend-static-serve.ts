import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { standalonePackageDir } from '@wrongstack/core/utils';
import {
  type CreateHttpServerOptions,
  createHttpServer,
  resolveCreateHttpServerOptions,
} from './http-server.js';
import { createProjectIntakeService } from './intake-service.js';
import { listenWithRetry } from './port-utils.js';
import { errMessage } from './ws-utils.js';

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
 * httpPort, globalRoot })`. The function returns
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

/** Read a manifest's `name` field, or undefined when it is absent/unparsable. */
function readPackageName(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/** Directory that `baseUrl` lives in, accepting both URL and path forms. */
function dirOf(baseUrl: string | URL): string {
  if (baseUrl instanceof URL || baseUrl.startsWith('file:')) {
    return path.dirname(fileURLToPath(baseUrl));
  }
  return path.dirname(path.resolve(baseUrl));
}

/**
 * pnpm-workspace fallback: find a sibling package by the workspace layout.
 *
 * `createRequire().resolve()` only sees packages a manifest actually declares
 * as a dependency. `@wrongstack/webui-server` deliberately does NOT depend on
 * `@wrongstack/webui` — the frontend is a sibling package, and the CLI→webui
 * cross-package edge was removed on purpose (audit §3.1.1) — so in a workspace
 * install the specifier throws and the whole lookup used to bail out with
 * `undefined`. `resolveDistDir` then returned null, `startStaticServe`
 * degraded to WS-only, and `GET /` answered 404 with no diagnostic anywhere.
 *
 * Walking up for a pnpm workspace root and reading `packages/<unscoped>` is
 * the same idiom `ensureDistDir` already uses to locate the build root, so
 * this stays consistent instead of introducing a second convention.
 */
function findWorkspaceSiblingPackageJson(
  packageName: string,
  startDir: string,
): string | undefined {
  const slash = packageName.indexOf('/');
  const unscoped = slash === -1 ? packageName : packageName.slice(slash + 1);
  if (!unscoped) return undefined;
  let dir = startDir;
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const candidate = path.join(dir, 'packages', unscoped, 'package.json');
      // Verify the manifest name: a directory called `webui` is only a match
      // if it actually declares the package we asked for.
      if (readPackageName(candidate) === packageName) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Bun-compatible replacement for Node's newer `module.findPackageJSON`. */
export function findInstalledPackageJson(
  specifier: string,
  baseUrl: string | URL = import.meta.url,
): string | undefined {
  const withoutManifest = specifier.replace(/\/package\.json$/u, '');
  const parts = withoutManifest.split('/');
  const packageName = withoutManifest.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!packageName) return undefined;
  const standaloneDir = standalonePackageDir(packageName);
  if (standaloneDir !== null) return path.join(standaloneDir, 'package.json');

  let current: string | undefined;
  try {
    current = path.dirname(createRequire(baseUrl).resolve(packageName));
  } catch {
    // Not resolvable as a dependency — fall through to the workspace layout.
    current = undefined;
  }
  for (let depth = 0; current !== undefined && depth < 12; depth++) {
    const candidate = path.join(current, 'package.json');
    if (readPackageName(candidate) === packageName) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return findWorkspaceSiblingPackageJson(packageName, dirOf(baseUrl));
}

export interface StaticServeOptions {
  getSessionProjectRoot?: CreateHttpServerOptions['getSessionProjectRoot'];
  host: string;
  httpPort: number;
  globalRoot: string;
  /** Explicit frontend build. Omitted for the regular @wrongstack/webui app. */
  distDir?: string | undefined;
  /** Push-on-write hook for `POST /api/fleet/ping` (immediate fleet re-broadcast). */
  onFleetPing?: (() => void) | undefined;
  /**
   * Live file-watcher metrics sink backing `GET /debug/watcher-metrics`.
   * Omitting it makes that route answer 503 and the WebUI Debug Dashboard
   * report the watcher as unavailable, so every host that embeds the WebUI
   * must thread its own metrics object through here — not just the
   * standalone `start-webui` server.
   */
  watcherMetrics?: CreateHttpServerOptions['watcherMetrics'];
  /** TechStack HTTP job events projected to the embedded WebSocket server. */
  onTechStackEvent?:
    | ((event: import('@wrongstack/webui-server').WSServerMessage) => void)
    | undefined;
  /**
   * Live provider access for TechStack's LLM research stage. Omitting it
   * leaves `analyze` deterministic — so this must be threaded here as well as
   * in the standalone `start-webui` server, or the CLI-hosted WebUI silently
   * loses LLM analysis while the standalone one has it.
   */
  getLlm?:
    | (() =>
        | { provider: import('@wrongstack/contracts/types').Provider; model: string }
        | undefined)
    | undefined;
  /** Active target project root for TechStack and CodeMap APIs. */
  projectRoot?: string | undefined;
  /**
   * Optional codebase-index directory override. `createHttpServer` hands the
   * whole options object to `handleApiRoutes`, so this reaches the
   * `/api/codemap/*` and `/api/deadcode/*` handlers. Omitting it here made the
   * CLI-embedded WebUI ignore a `meta.codebaseIndexDir` override and silently
   * fall back to the default `<projectRoot>/.codebase-index`.
   */
  indexDir?: CreateHttpServerOptions['indexDir'];
  /**
   * TechStack package add/remove execution. Forwarded by the standalone
   * `startHttpServer` path but historically dropped here, leaving the
   * CLI-embedded WebUI without working package operations.
   */
  executePackageOperation?: CreateHttpServerOptions['executePackageOperation'];
  /** Public browser-facing WS URL injected into the React app. */
  publicWsUrl?: string | undefined;
  /**
   * Shared auth token for `/ws-auth` and `/api/*` endpoints. Required for
   * the cookie-based auth flow: the frontend extracts this from the URL,
   * calls `/ws-auth?token=...` to get an HttpOnly cookie, then uses the
   * cookie for subsequent WS upgrades (closing C-598 query-string exposure).
   */
  apiToken?: string | undefined;
  /** Force token auth even when the server binds to loopback. */
  requireToken?: boolean | undefined;
  /**
   * Extra hostnames the HTTP CSRF/DNS-rebinding guard accepts, for operators
   * fronting the WebUI with a tunnel or reverse proxy. `publicWsUrl`'s hostname
   * is trusted implicitly; set this when the browser-facing HTTP origin differs
   * from it (WS-001).
   */
  allowedHostnames?: readonly string[] | undefined;
  /** `/ws-auth` cookie exchange; defaults to enabled (see `CreateHttpServerOptions`). */
  enableWsCookie?: CreateHttpServerOptions['enableWsCookie'];
  /** `Secure` auth cookie; inferred from a `wss://` `publicWsUrl` when omitted. */
  secureCookies?: CreateHttpServerOptions['secureCookies'];
  /**
   * When true, skip `server.listen()` — the caller is responsible for
   * calling listen after attaching the WebSocketServer. This prevents
   * a race where a WS upgrade request arrives between the server
   * listening and the WebSocketServer being attached.
   */
  deferListen?: boolean | undefined;
  /**
   * Fail-fast port binding (no auto-advance on EADDRINUSE). Mirrors
   * `WEBUI_STRICT_PORT` semantics for hosts that resolved the port without
   * probing.
   */
  strictPort?: boolean | undefined;
  /** Package-resolution/build seams supplied by the owning host. */
  ensureDistDeps?: EnsureDistDeps | undefined;
  /**
   * Requirements Intake service backing `/api/requirement-intakes*`. Omitted by
   * every real host — a per-project service is constructed from `projectRoot` +
   * `globalRoot` below, so the CLI-hosted WebUI serves the same intake records
   * as the standalone server. Pass one only to override (tests/embeds); when
   * `projectRoot` is absent there is no project to scope a store to and the
   * routes correctly answer 503.
   */
  intakeService?: CreateHttpServerOptions['intakeService'];
  /**
   * Optional vector-memory store. When provided, the four
   * `/api/vector-memory/{status,search,store,store/:id}` endpoints become
   * active. When omitted, the routes respond with `{ enabled: false }` or
   * 503 — a non-CLI webui-server host stays on its existing surface with
   * zero behavior change.
   */
  getVectorMemoryStore?: CreateHttpServerOptions['getVectorMemoryStore'];
  /** Model cache directory for the vector-memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
  /**
   * Extra origins added to the served page's `connect-src`. The WebUI topbar
   * probes the operator's HQ / WrongProxy endpoints from the browser, so this
   * must be wired here as well as in the standalone `start-webui` server, or
   * the CLI-hosted WebUI keeps reporting those integrations as unreachable
   * while the standalone one reads them correctly.
   */
  getExtraConnectSrc?: CreateHttpServerOptions['getExtraConnectSrc'];
  getIntegrationTarget?: CreateHttpServerOptions['getIntegrationTarget'];
}

/**
 * Resolve the webui package's built `dist` directory.
 *
 * Returns the absolute path, or `null` if the package or its built
 * `index.html` cannot be found. This is the one piece of
 * `startStaticServe` that touches the module tree, so it lives behind
 * its own function: tests can exercise the resolution (and stub it)
 * without binding a socket.
 */
export interface ResolveDistOptions {
  /** Explicit frontend build directory. */
  explicitDistDir?: string | undefined;
  /** Package resolver seam used by tests. */
  resolvePackageJson?: ((id: string) => string) | undefined;
  /** Filesystem seam used by tests. */
  exists?: ((file: string) => boolean) | undefined;
}

/**
 * Resolve the WebUI dist directory without building it.
 *
 * The string form is retained for callers that provide an explicit frontend
 * directory. The options form exposes package/filesystem seams for the
 * cold-start resolver and its unit tests.
 */
export function resolveDistDir(input?: string | ResolveDistOptions): string | null {
  const options: ResolveDistOptions =
    typeof input === 'string' ? { explicitDistDir: input } : (input ?? {});
  if (options.explicitDistDir) return path.resolve(options.explicitDistDir);

  const exists = options.exists ?? existsSync;

  let packageTarget: string | undefined;
  try {
    packageTarget = options.resolvePackageJson
      ? options.resolvePackageJson('@wrongstack/webui/package.json')
      : findInstalledPackageJson('@wrongstack/webui', import.meta.url);
  } catch {
    if (!options.resolvePackageJson) return null;
    throw new Error(
      '@wrongstack/webui package could not be resolved. Install workspace dependencies and rebuild the CLI.',
    );
  }
  if (!packageTarget) return null;

  // Older seams resolved the package's built server entry, while the new seam
  // resolves package.json so discovery still works before the first build.
  const distDir =
    path.basename(packageTarget) === 'package.json'
      ? path.join(path.dirname(packageTarget), 'dist')
      : path.dirname(packageTarget);
  if (options.exists === undefined && options.resolvePackageJson) return distDir;
  return exists(path.join(distDir, 'index.html')) ? distDir : null;
}

/**
 * Injectable seams for `ensureDistDir`. Both default to the real
 * implementations; tests override them to assert the auto-build path
 * without spawning `pnpm` or walking the real filesystem.
 */
export interface EnsureDistDeps extends Omit<ResolveDistOptions, 'explicitDistDir'> {
  /** Build command runner (tests override to no-op or assert cwd). */
  runBuild?: (cwd: string) => void | Promise<void>;
  /** Workspace-root finder (tests return a fake monorepo root). */
  findWorkspaceRoot?: (packageDir: string) => string | null;
}

/**
 * Resolve the WebUI dist, auto-building it when missing.
 *
 * Mirrors the SimpleUI cold-start recovery in `simpleui-dist.ts`:
 * after a fresh clone, `git clean`, or dependency update the `dist/`
 * directory (gitignored) may not exist. Instead of silently degrading
 * to WS-only, this function runs the Vite build automatically and
 * retries resolution. Explicit missing directories return `null` so
 * callers can intentionally run WS-only; package and build failures
 * throw descriptive errors instead of silently hiding a broken install.
 */
export async function ensureDistDir(
  explicitDistDir?: string,
  deps: EnsureDistDeps = {},
): Promise<string | null> {
  const exists = deps.exists ?? existsSync;
  if (explicitDistDir) {
    const resolved = path.resolve(explicitDistDir);
    return exists(path.join(resolved, 'index.html')) ? resolved : null;
  }

  const resolveOptions: ResolveDistOptions = {
    resolvePackageJson: deps.resolvePackageJson,
    exists,
  };
  const resolved = resolveDistDir(resolveOptions);
  if (resolved !== null) return resolved;

  // Locate the workspace root to run the pnpm build command.
  let packageDir: string;
  try {
    const packageJson = deps.resolvePackageJson
      ? deps.resolvePackageJson('@wrongstack/webui/package.json')
      : findInstalledPackageJson('@wrongstack/webui', import.meta.url);
    if (!packageJson) throw new Error('not found');
    packageDir = path.dirname(packageJson);
  } catch {
    throw new Error(
      '@wrongstack/webui package could not be resolved. Install workspace dependencies and rebuild the CLI.',
    );
  }

  const findRoot =
    deps.findWorkspaceRoot ??
    ((pkgDir: string): string | null => {
      let dir = pkgDir;
      for (let i = 0; i < 10; i++) {
        if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
      return null; // not in a pnpm workspace — can't auto-build
    });

  const workspaceRoot = findRoot(packageDir);
  if (workspaceRoot === null) {
    throw new Error(`@wrongstack/webui is not inside a pnpm workspace (started at ${packageDir}).`);
  }

  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'webui.auto_build',
      message: 'Frontend not built — building now',
      timestamp: new Date().toISOString(),
    }),
  );

  const runBuild =
    deps.runBuild ?? ((cwd: string) => runPnpmBuild(cwd, '@wrongstack/webui', 180_000));

  try {
    await runBuild(workspaceRoot);
  } catch (error) {
    throw new Error(
      `webui.auto_build.failed: ${errMessage(error)}. ` +
        'Run `pnpm --filter @wrongstack/webui build` manually.',
    );
  }

  const afterBuild = resolveDistDir(resolveOptions);
  if (afterBuild === null) {
    throw new Error(
      '@wrongstack/webui frontend is not built. Run `pnpm --filter @wrongstack/webui build`.',
    );
  }
  return afterBuild;
}

/**
 * Announce that the frontend could not be resolved.
 *
 * A null dist is a DEGRADED boot, not a clean shutdown: the host keeps its
 * WebSocket surface and every static request answers 404. Nothing logged that,
 * so an operator saw a WebUI that simply had no pages, and the only clue was
 * a bare "Not found" body. The remedy is spelled out here because the call
 * site has already lost the context of what was tried.
 */
export function warnFrontendUnavailable(reason: string, detail?: string): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'webui.frontend_unavailable',
      message:
        `Frontend not resolved (${reason}) — serving WebSocket only; ` +
        `every static request will answer 404. ` +
        (detail ??
          'Build it with `pnpm --filter @wrongstack/webui build`, or pass an explicit dist directory.'),
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Injectable seams for `startStaticServe`. Both default to
 * the real implementations; tests override them to assert
 * the wiring without resolving the webui package or binding
 * a real port.
 */
export interface StaticServeDeps {
  resolveDist?: (explicitDistDir?: string) => string | null;
  ensureDist?: (
    explicitDistDir?: string,
    deps?: EnsureDistDeps,
  ) => string | null | Promise<string | null>;
  ensureDistDeps?: EnsureDistDeps;
  createServer?: (opts: CreateHttpServerOptions) => Server;
}

export async function startStaticServe(
  opts: StaticServeOptions,
  deps: StaticServeDeps = {},
): Promise<StaticServeHandle | null> {
  const ensureDistDeps = deps.ensureDistDeps ?? opts.ensureDistDeps;
  const ensureDist = (explicit: string | undefined) =>
    deps.ensureDist
      ? deps.ensureDist(explicit, ensureDistDeps)
      : ensureDistDir(explicit, ensureDistDeps);
  const create = deps.createServer ?? createHttpServer;

  const distDir = deps.resolveDist
    ? deps.resolveDist(opts.distDir)
    : await ensureDist(opts.distDir);
  if (distDir === null) {
    warnFrontendUnavailable('no frontend dist could be resolved');
    return null;
  }

  const intakeService =
    opts.intakeService ??
    (opts.projectRoot
      ? createProjectIntakeService({
          projectRoot: opts.projectRoot,
          globalRoot: opts.globalRoot,
        })
      : undefined);

  const server = create(
    resolveCreateHttpServerOptions({
      getSessionProjectRoot: opts.getSessionProjectRoot,
      host: opts.host,
      port: opts.httpPort,
      distDir,
      globalRoot: opts.globalRoot,
      onFleetPing: opts.onFleetPing,
      watcherMetrics: opts.watcherMetrics,
      onTechStackEvent: opts.onTechStackEvent,
      getLlm: opts.getLlm,
      projectRoot: opts.projectRoot,
      indexDir: opts.indexDir,
      executePackageOperation: opts.executePackageOperation,
      publicWsUrl: opts.publicWsUrl,
      apiToken: opts.apiToken,
      requireToken: opts.requireToken,
      allowedHostnames: opts.allowedHostnames,
      enableWsCookie: opts.enableWsCookie,
      secureCookies: opts.secureCookies,
      intakeService,
      getExtraConnectSrc: opts.getExtraConnectSrc,
      getIntegrationTarget: opts.getIntegrationTarget,
      getVectorMemoryStore: opts.getVectorMemoryStore,
      vectorMemoryModelCacheDir: opts.vectorMemoryModelCacheDir,
    }),
  );

  if (!opts.deferListen) {
    // Bind-time EADDRINUSE safety net: `findFreePort` probes with a
    // throwaway listener that closes, so a competitor can still take the
    // port between probe and bind (TOCTOU). Advance past it (bounded)
    // instead of crashing; strict hosts pass `strictPort` for fail-fast.
    const boundPort = await listenWithRetry(server, opts.host, opts.httpPort, {
      maxTries: opts.strictPort ? 1 : 10,
    });
    return { server, port: boundPort };
  }
  // Deferred hosts bind later (after attaching the WebSocketServer) and
  // reconcile the bound port themselves; report the requested port here.
  return { server, port: opts.httpPort };
}

function runPnpmBuild(cwd: string, workspace: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', workspace, 'build'], {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`build timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pnpm build exited with code ${String(code)}`));
    });
  });
}
