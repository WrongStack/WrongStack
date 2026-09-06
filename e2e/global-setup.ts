import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FullConfig } from '@playwright/test';

/**
 * Starts the WrongStack CLI in webui mode and waits for the HTTP server
 * to be ready before running tests. The server process is killed when all
 * tests complete.
 *
 * Environment variables:
 *   WEBUI_URL    — base URL of an already-running server (skip startup)
 *   CLI_PATH     — path to the CLI binary (default: packages/cli/dist/index.js)
 *   E2E_PROVIDER — provider id passed through as --provider (CI only)
 *   E2E_MODEL    — model id passed through as --model (CI only)
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = process.env.WEBUI_URL;

  if (baseURL) {
    // External server — verify it is up.
    const ok = await waitForUrl(baseURL, 10_000);
    if (!ok) throw new Error(`WEBUI_URL=${baseURL} is not reachable`);
    return;
  }

  const configuredBaseURL = (config.projects[0]?.use as { baseURL?: unknown } | undefined)?.baseURL;
  const expectedURL =
    typeof configuredBaseURL === 'string'
      ? new URL(configuredBaseURL)
      : new URL('http://127.0.0.1:3456');

  // Start the CLI in webui mode.
  const cliPath = process.env.CLI_PATH ?? 'packages/cli/dist/index.js';
  // CI boots the WebUI without a saved config. E2E_PROVIDER/E2E_MODEL (set in
  // ci.yml) are surfaced as --provider/--model so boot skips the auth gate and
  // the server starts in the ready (chat) state instead of the setup screen.
  const providerOverride = process.env.E2E_PROVIDER;
  const modelOverride = process.env.E2E_MODEL;
  const providerSet = providerOverride !== undefined && providerOverride !== '';
  const modelSet = modelOverride !== undefined && modelOverride !== '';
  if (providerSet !== modelSet) {
    // Partial overrides would silently fall back to the dev's saved config
    // (or the setup screen) — fail fast instead of debugging that later.
    throw new Error('E2E_PROVIDER and E2E_MODEL must be set together (or both omitted)');
  }
  const cliArgs: string[] = [cliPath, '--webui'];
  if (providerSet && modelSet) {
    cliArgs.push('--provider', providerOverride as string, '--model', modelOverride as string);
  }
  const server = spawn('node', cliArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Playwright resolves `use.baseURL` before global setup runs. Pin the CLI
    // to that exact address so auto-port fallback cannot start a healthy server
    // somewhere the browser workers will never visit.
    env: {
      ...process.env,
      WEBUI_HOST: expectedURL.hostname,
      WEBUI_PORT: expectedURL.port || (expectedURL.protocol === 'https:' ? '443' : '80'),
      WEBUI_STRICT_PORT: '1',
      // Chalk emits ANSI codes when it (incorrectly) guesses a TTY; strip
      // them so the readiness regexes match the plain-text banner.
      NO_COLOR: '1',
      // A boot that dies quietly is the failure mode this setup keeps hitting
      // (CI: exit 0, no banner, three INFO lines of output). Debug logging
      // shows how far boot got, and `--trace-exit` prints a stack trace for
      // any explicit `process.exit()` — which separates "something called
      // exit" from "the event loop simply emptied out".
      WRONGSTACK_LOG_LEVEL: process.env.WRONGSTACK_LOG_LEVEL ?? 'debug',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--trace-exit'].filter(Boolean).join(' '),
    },
  });

  // Capture server output for debugging and readiness polling. The canonical
  // stdout line ([WebUI] HTTP server running on <url>) is not emitted on every
  // build path, but the CLI's stderr banner (✦ WebUI running → <url>) is
  // printed by dispatch-webui on every --webui boot and carries the bound URL.
  let combined = '';
  server.stdout?.on('data', (chunk) => {
    combined += chunk;
    process.stdout.write(`[webui:stdout] ${chunk}`);
  });
  server.stderr?.on('data', (chunk) => {
    combined += chunk;
    process.stderr.write(`[webui:stderr] ${chunk}`);
  });

  // Wait for a readiness line (stdout or stderr), an early exit, or timeout.
  // Pass a getter — a by-value snapshot would freeze the empty initial string.
  const outcome = await waitForServerOutput(server, () => combined, 60_000);
  if (outcome.url === null) {
    server.kill();
    // Distinguish the two failure shapes. They have nothing in common:
    // "the banner never appeared in 60s" is a slow/hung boot, while
    // "the process exited after 3s" is a crash — and a crash that produced
    // no stderr (a signal kill, e.g. the OOM killer) leaves the exit status
    // as the ONLY evidence there is. Reporting both as a timeout threw that
    // evidence away and made every CI failure here unactionable.
    throw new Error(describeStartFailure(outcome, combined));
  }
  const url = outcome.url;

  if (new URL(url).origin !== expectedURL.origin) {
    server.kill();
    throw new Error(
      `WebUI started at ${url}, but Playwright is configured for ${expectedURL.origin}`,
    );
  }

  if (!(await waitForUrl(url, 10_000))) {
    server.kill();
    throw new Error(`WebUI announced ${url}, but it never became reachable`);
  }

  // Give the WebSocket port a moment to stabilise.
  await sleep(500);

  // Store the HTTP URL so tests use it as baseURL.
  process.env.WEBUI_URL = url;
  (config as FullConfig & { _serverProcess: typeof server })._serverProcess = server;
}

/** How `waitForServerOutput` finished: the banner, an early exit, or the deadline. */
type StartOutcome =
  | { url: string; reason: 'ready' }
  | { url: null; reason: 'timeout'; timeout: number }
  | { url: null; reason: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { url: null; reason: 'spawn-error'; error: Error };

/** Human-readable cause plus the tail of whatever the server managed to print. */
function describeStartFailure(
  outcome: Extract<StartOutcome, { url: null }>,
  combined: string,
): string {
  const head =
    outcome.reason === 'exit'
      ? `WebUI server exited before it was ready (code ${outcome.code ?? 'null'}, signal ${
          outcome.signal ?? 'none'
        })`
      : outcome.reason === 'spawn-error'
        ? `WebUI server could not be spawned: ${outcome.error.message}`
        : `WebUI server failed to start within ${outcome.timeout / 1000}s`;
  const tail = combined.trim().split(/\r?\n/).slice(-40).join('\n');
  return tail ? `${head}\n── last output ──\n${tail}` : `${head} (it printed nothing)`;
}

/** Wait for either readiness line, an early exit, or the deadline. */
async function waitForServerOutput(
  server: ReturnType<typeof spawn>,
  getCombined: () => string,
  timeout: number,
): Promise<StartOutcome> {
  const patterns = [
    /\[WebUI\] HTTP server running on (https?:\/\/[^\s]+)/,
    /✦ WebUI running → (https?:\/\/[^\s]+)/,
  ];
  const poll = (): string | null => {
    const combined = getCombined();
    for (const re of patterns) {
      const match = combined.match(re);
      if (match) {
        const announced = new URL(match[1]!);
        // The banner URL carries `?token=` when auth is active. Export it
        // so specs can authenticate (see e2e/vector-memory-panel.spec.ts —
        // WEBUI_E2E_TOKEN). Purely additive: no spec is required to use it.
        const bannerToken = announced.searchParams.get('token');
        if (bannerToken) process.env.WEBUI_E2E_TOKEN = bannerToken;
        announced.search = '';
        return announced.origin;
      }
    }
    return null;
  };
  const already = poll();
  if (already) return { url: already, reason: 'ready' };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: StartOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      server.off('exit', onExit);
      server.off('error', onError);
      resolve(outcome);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      // The banner may sit in a stdout chunk delivered in the same tick as
      // the exit; poll once more so a fast-but-successful boot is not
      // misreported as a crash.
      const found = poll();
      finish(found ? { url: found, reason: 'ready' } : { url: null, reason: 'exit', code, signal });
    };
    const onError = (error: Error): void => finish({ url: null, reason: 'spawn-error', error });
    const timer = setTimeout(() => finish({ url: null, reason: 'timeout', timeout }), timeout);
    const poller = setInterval(() => {
      const found = poll();
      if (found) finish({ url: found, reason: 'ready' });
    }, 250);
    server.once('exit', onExit);
    server.once('error', onError);
  });
}

/** Verify a URL responds with HTTP 200. */
async function waitForUrl(url: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  return false;
}
