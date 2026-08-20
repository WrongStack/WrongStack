/**
 * Best-effort "open this URL in the default browser" for `--webui --open`.
 *
 * Cross-platform via the OS opener (`start` / `open` / `xdg-open`). Fully
 * fire-and-forget: a missing opener, a headless box, or a spawn failure must
 * NEVER take the server down — the URL is always also printed to the console.
 */

import { spawn } from 'node:child_process';

/**
 * cmd.exe metacharacters, matching the set `shell-open.ts` already enforces.
 *
 * The old comment on the win32 branch claimed the `""` title slot made `&`
 * "pass through intact". It does not: Node only quotes a spawn argument that
 * contains whitespace, so a space-free URL like `https://x/?a=1&calc` reaches
 * cmd.exe with `&` as a live command separator (verified 2026-08-20).
 */
const URL_METACHAR_REGEX = /[&|;<>(){}^"'`%\n\r\0]/;

/**
 * True when `url` is safe to hand to an OS opener.
 *
 * Scheme is checked as well as metacharacters: an opener will happily launch
 * `file:`, `ms-msdt:` or a UNC path, and this function's callers include one
 * (`github-copilot-oauth.ts`) whose URL comes from an HTTP response body rather
 * than from our own code.
 */
export function isSafeBrowserUrl(url: string): boolean {
  if (URL_METACHAR_REGEX.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Resolve the platform's URL-opener command + args. */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    // The empty "" is the window title slot. See URL_METACHAR_REGEX above for
    // why the URL itself must be validated before it gets here.
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Spawn the OS browser-opener for `url` and register it as a protected
 *  process so it survives kill/killAll. Never throws. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  // Refuse rather than sanitize: every legitimate caller passes an ordinary
  // http(s) URL, so anything rejected here is a bug or an attack, and silently
  // "fixing" it would open a different address than the one requested.
  if (!isSafeBrowserUrl(url)) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'open_browser.refused',
        message: 'Refusing to open a URL with an unexpected scheme or shell metacharacter',
      }),
    );
    return;
  }
  try {
    const { command, args } = browserOpenCommand(url, platform);
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    // A missing opener (e.g. xdg-open absent on a headless box) surfaces as an
    // async 'error' event — swallow it so it doesn't crash the process.
    child.on('error', () => {});
    child.unref();

    // Register the browser process as protected so process.kill / killAll
    // never accidentally terminates it — that would crash the webui session.
    // The registry is imported lazily to avoid a circular dependency with
    // @wrongstack/tools (which the webui server does not directly depend on).
    if (child.pid) {
      try {
        // Dynamic import to avoid hard dependency on @wrongstack/tools from
        // this module (the webui server may not have tools installed).
        import('@wrongstack/tools').then(({ getProcessRegistry }) => {
          const pid = child.pid;
          if (pid === undefined) return;
          getProcessRegistry().register({
            pid,
            name: 'browser',
            command: `${command} ${args.join(' ')}`,
            startedAt: Date.now(),
            child,
            protected: true,
          });
          // Auto-unregister on exit so the process list stays accurate.
          child.on('exit', () => {
            getProcessRegistry().unregister(pid);
          });
        }).catch(() => {
          // @wrongstack/tools may not be available — silently skip registration.
        });
      } catch {
        // Module resolution failure — silently skip.
      }
    }
  } catch {
    // Synchronous spawn failure — best-effort, ignore.
  }
}
