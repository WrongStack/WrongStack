/**
 * Terminal-side adapter for the OAuth loopback callback server.
 *
 * The server itself — HTTP listener, port fallback, `state` validation, the
 * static callback page and its CSP/anti-framing headers, abort handling — lives
 * in `@wrongstack/providers/oauth`. This file used to carry a second, complete
 * implementation of all of it.
 *
 * The copies were not identical, and the difference mattered: this one
 * registered its abort listener with `{ once: true }` and never removed it, so
 * every completed login leaked a listener on the caller's long-lived
 * AbortSignal (the TUI hands the same signal to each attempt). The providers
 * copy had the `detachAbort` cleanup. Neither file had any way to notice the
 * other had drifted.
 *
 * What legitimately stays here is {@link openBrowser}: spawning the platform
 * browser is terminal-only behaviour, and the headless WebUI flows deliberately
 * hand the authorize URL to the client instead of opening anything.
 *
 * The positional signature below is preserved so the three CLI OAuth flows and
 * their tests keep working unchanged.
 *
 * @module auth-menu/loopback-server
 */

import { spawn } from 'node:child_process';
import {
  type LoopbackServer,
  startLoopbackServer as startSharedLoopbackServer,
} from '@wrongstack/providers/oauth';

export { callbackHtml, type LoopbackServer } from '@wrongstack/providers/oauth';

/** Result of waiting for the OAuth callback. */
export interface LoopbackCallback {
  /** The authorization code from the provider. */
  code: string;
  /** The OAuth state parameter from the callback (validated against expected). */
  state: string;
}

// ── Platform browser opener (best-effort) ─────────────────────────────────

/**
 * Open a URL in the user's default browser. Best-effort — never throws.
 *
 * - Windows: `cmd /c start "" <url>`
 * - macOS: `open <url>`
 * - Linux: `xdg-open <url>`
 *
 * Not `detached`: the CLI flows wait on the loopback callback in the
 * foreground, so the opener is a short-lived handoff. (The WebUI server's
 * `openBrowser` is deliberately different — it detaches and registers the pid
 * as protected because it launches a browser the session must outlive.)
 */
/**
 * cmd.exe metacharacters plus the scheme check, kept in sync with
 * `webui-server/src/server/open-browser.ts`.
 *
 * This copy matters more than that one: its callers include the GitHub Copilot
 * device-code flow, which passes `device.verification_uri` straight from an HTTP
 * response body after checking only that it is truthy. A compromised or
 * MITM'd OAuth response could therefore choose the string handed to
 * `cmd /c start`, and Node only quotes spawn arguments containing whitespace —
 * so a space-free `&command` is a live cmd.exe separator (verified 2026-08-20).
 */
const URL_METACHAR_REGEX = /[&|;<>(){}^"'`%\n\r\0]/;

function isSafeBrowserUrl(url: string): boolean {
  if (URL_METACHAR_REGEX.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openBrowser(url: string): void {
  if (!isSafeBrowserUrl(url)) {
    // Refuse rather than sanitize — the URL is always printed for the user to
    // open manually, so nothing is lost by declining a suspicious one.
    return;
  }
  try {
    const platform = process.platform;
    const { command, args } =
      platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : platform === 'darwin'
          ? { command: 'open', args: [url] }
          : { command: 'xdg-open', args: [url] };
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort — the URL is always printed in the terminal.
  }
}

// ── Loopback callback server ──────────────────────────────────────────────

/**
 * Start a loopback HTTP server for the OAuth authorization-code callback.
 *
 * Binds the first available port from `ports`. If all are busy, `bound` is
 * `false` and the caller falls back to a manual paste prompt. When `signal`
 * aborts (Ctrl+C, TUI Esc), the pending `waitForCode()` resolves to `null` and
 * the server is torn down.
 *
 * @param expectedState - the OAuth `state` to validate the callback against
 * @param ports - ordered ports to try; first available wins
 * @param signal - optional external cancellation
 * @param callbackPath - path the provider redirects to (default `/auth/callback`)
 * @param redirectHost - hostname to listen on (default `127.0.0.1`)
 */
export function startLoopbackServer(
  expectedState: string,
  ports: readonly number[],
  signal?: AbortSignal,
  callbackPath = '/auth/callback',
  redirectHost = '127.0.0.1',
): Promise<LoopbackServer> {
  const [primary = 1455, ...fallbackPorts] = ports;
  return startSharedLoopbackServer({
    port: primary,
    fallbackPorts: [...fallbackPorts],
    host: redirectHost,
    path: callbackPath,
    expectedState,
    ...(signal ? { signal } : {}),
  });
}
