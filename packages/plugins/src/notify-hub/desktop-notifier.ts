/**
 * Local desktop notifications for notify-hub: a toast when the run waits on
 * the user (a permission prompt, a question) and when a turn ends, so a
 * session in another window does not sit waiting unseen.
 *
 * The title and body never enter a command line. Each platform command reads
 * them from environment variables (`WS_NOTIFY_TITLE` / `WS_NOTIFY_BODY`), so a
 * tool name or a question text holding quotes, `$(...)` or backticks is data,
 * not code. Every call is fire-and-forget with a hard timeout: a hung
 * notification daemon can never hold up the agent.
 */
import { execFile } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core/utils';
import { nonnegativeFiniteLimit, safePrefix } from '../runtime/string-boundaries.js';

export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

export interface DesktopCommand {
  file: string;
  args: string[];
}

/**
 * Windows PowerShell 5.1, not pwsh: the WinRT projection that loads
 * `ToastNotificationManager` was removed in PowerShell 7. The AppUserModelID
 * is Windows PowerShell's own — a toast from an unregistered id is dropped
 * silently on Windows 10/11.
 */
const WINDOWS_TOAST = [
  '$ErrorActionPreference = "Stop"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$texts = $xml.GetElementsByTagName("text")',
  '$texts.Item(0).AppendChild($xml.CreateTextNode($env:WS_NOTIFY_TITLE)) > $null',
  '$texts.Item(1).AppendChild($xml.CreateTextNode($env:WS_NOTIFY_BODY)) > $null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
].join('; ');

/** The command that shows one notification, or null on a platform with none. */
export function desktopCommand(platform: NodeJS.Platform): DesktopCommand | null {
  switch (platform) {
    case 'win32':
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WINDOWS_TOAST,
        ],
      };
    case 'darwin':
      return {
        file: 'osascript',
        args: [
          '-e',
          'display notification (system attribute "WS_NOTIFY_BODY") with title (system attribute "WS_NOTIFY_TITLE")',
        ],
      };
    case 'linux':
      // notify-send takes title and body as argv items — no shell involved.
      return { file: 'notify-send', args: ['--app-name=WrongStack'] };
    default:
      return null;
  }
}

/** One line, bounded, markdown marks stripped — a toast is not a document. */
export function toastText(text: string, max: number): string {
  const line = text
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = nonnegativeFiniteLimit(max);
  if (limit === 0) return '';
  return line.length > limit ? `${safePrefix(line, limit - 1)}…` : line;
}

export interface DesktopNotifierOptions {
  platform?: NodeJS.Platform | undefined;
  /** Same-kind notifications closer together than this are dropped. */
  minIntervalMs?: number | undefined;
  onError?: ((message: string) => void) | undefined;
  exec?: typeof execFile | undefined;
}

export class DesktopNotifier {
  readonly #command: DesktopCommand | null;
  readonly #minIntervalMs: number;
  readonly #onError: (message: string) => void;
  readonly #exec: typeof execFile;
  readonly #lastSent = new Map<string, number>();
  #errorReported = false;
  sent = 0;
  failed = 0;

  constructor(opts: DesktopNotifierOptions = {}) {
    this.#command = desktopCommand(opts.platform ?? process.platform);
    this.#minIntervalMs =
      typeof opts.minIntervalMs === 'number' &&
      Number.isFinite(opts.minIntervalMs) &&
      opts.minIntervalMs >= 0
        ? opts.minIntervalMs
        : 10_000;
    this.#onError = opts.onError ?? (() => {});
    this.#exec = opts.exec ?? execFile;
  }

  get supported(): boolean {
    return this.#command !== null;
  }

  /** Show a notification. `kind` rate-limits repeats of one kind (turn ends in a loop). */
  notify(kind: string, title: string, body: string, now = Date.now()): boolean {
    const cmd = this.#command;
    if (!cmd) return false;
    const last = this.#lastSent.get(kind);
    if (last !== undefined && now - last < this.#minIntervalMs) return false;
    this.#lastSent.set(kind, now);
    const safeTitle = toastText(title, 80);
    const safeBody = toastText(body, 200);
    const args = cmd.file === 'notify-send' ? [...cmd.args, safeTitle, safeBody] : cmd.args;
    try {
      const child = this.#exec(
        cmd.file,
        args,
        {
          windowsHide: true,
          timeout: 5_000,
          // Credentials stripped: a notification command needs none of them.
          env: { ...buildChildEnv(), WS_NOTIFY_TITLE: safeTitle, WS_NOTIFY_BODY: safeBody },
        },
        (err) => {
          if (!err) return;
          this.failed += 1;
          this.#reportOnce(`${cmd.file} failed: ${err.message.split('\n')[0] ?? ''}`);
        },
      );
      child.on?.('error', () => {});
      this.sent += 1;
      return true;
    } catch (err) {
      this.failed += 1;
      this.#reportOnce(
        `${cmd.file} could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  #reportOnce(message: string): void {
    if (this.#errorReported) return;
    this.#errorReported = true;
    this.#onError(message);
  }
}
