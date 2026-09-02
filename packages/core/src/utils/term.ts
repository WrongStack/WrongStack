/**
 * TTY detection helpers — the single source of truth for "is this process
 * running against a real terminal?". Replaces ad-hoc `process.stdin.isTTY`
 * / `process.stdout.isTTY` checks scattered across the codebase so that:
 *
 *   1. test code can mock a single module instead of stubbing `isTTY` on
 *      every ReadStream/WriteStream the test happens to touch;
 *   2. a future TTY-detection source (an env var override, a Windows
 *      ConPTY workaround, …) lands in one place;
 *   3. `isInteractive()` encodes the rule the project already used inline
 *      ("both streams are TTYs AND we're not running under CI") in one
 *      testable helper instead of the same 3-condition check in two
 *      different files.
 *
 * Scope: detection only. Raw-mode control (`setRawMode`), resize
 * subscriptions, and write-injection belong to a future, larger TTY
 * abstraction; this module is the smallest pull that gives us a
 * testable seam and dedups 20+ call sites.
 */

const hasStdout = (): boolean => typeof process !== 'undefined' && !!process.stdout;
const hasStdin = (): boolean => typeof process !== 'undefined' && !!process.stdin;

/** True when `process.stdout` is attached to a terminal (not a pipe/file). */
export function isStdoutTTY(): boolean {
  return hasStdout() && Boolean(process.stdout.isTTY);
}

/** True when `process.stdin` is attached to a terminal (not a pipe/file). */
export function isStdinTTY(): boolean {
  return hasStdin() && Boolean(process.stdin.isTTY);
}

/**
 * True when the current process is an interactive session: both stdin and
 * stdout are TTYs. Callers that also need a "not a single-shot invocation"
 * or "not under CI" check should layer that on top — keeping this helper
 * minimal preserves the original inline checks it replaces.
 */
export function isInteractive(): boolean {
  return isStdinTTY() && isStdoutTTY();
}

/** Current terminal size in characters, with a 24×80 fallback for non-TTYs. */
export function getTermSize(): { rows: number; cols: number } {
  if (!hasStdout()) return { rows: 24, cols: 80 };
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
}

/**
 * Subscribe to terminal resize events. `cb` is called with the new size each
 * time the underlying stream emits `resize`. Returns a cleanup function the
 * caller MUST call on dispose to remove the listener — leaving a stale
 * `resize` listener on a disposed component leaks the closure (and the
 * component itself, transitively) until the process exits.
 *
 * The stream argument defaults to `process.stdout`. Pass an explicit
 * `NodeJS.WriteStream` when the caller already owns one (e.g. a status line
 * that targets an injected `out` for testability). For non-TTY streams no
 * listener is registered and the returned cleanup is a no-op.
 */
export function onResize(
  cb: (size: { rows: number; cols: number }) => void,
  stream: NodeJS.WriteStream = process.stdout,
): () => void {
  if (!stream || typeof stream.on !== 'function') return () => {};
  const handler = (): void => {
    cb({
      rows: stream.rows ?? 24,
      cols: stream.columns ?? 80,
    });
  };
  stream.on('resize', handler);
  return () => {
    stream.off('resize', handler);
  };
}

/**
 * Toggle raw mode on a TTY stdin stream. Returns `true` when the toggle was
 * applied, `false` when the stream is null, not a TTY, or doesn't expose
 * `setRawMode` (pipes, file descriptors, Windows ConPTY edge cases). Callers
 * that need to restore the previous mode should snapshot `input.isRaw`
 * BEFORE the call and pass the value to a second call to flip back.
 *
 * Use this helper to drop the now-redundant
 * `if (input.isTTY) input.setRawMode(...)` ceremony at every call site.
 */
export function setRawMode(input: NodeJS.ReadStream, mode: boolean): boolean {
  if (input?.isTTY !== true) return false;
  if (typeof input.setRawMode !== 'function') return false;
  input.setRawMode(mode);
  return true;
}

/**
 * Bracket installed by the interactive input reader while a `readline`
 * prompt is on screen. Out-of-band terminal writes — logger WARN/INFO
 * lines, async activity from the Telegram bridge, etc. — go to the same
 * physical terminal as the half-typed prompt but readline has no idea they
 * happened, so it never repaints. The result is the classic corruption the
 * user sees: every async line strands the in-progress draft as a fresh
 * scrollback row (sometimes with its cursor underline).
 *
 * The guard closes that gap. `suspend()` wipes the draft row so the message
 * prints clean; `resume()` repaints the prompt + draft (cursor preserved).
 * When no prompt is active the guard is `null` and writes pass straight
 * through — so agent-turn output (spinner, renderer) is untouched.
 */
export interface OutputLineGuard {
  /** Clear the current input row right before an out-of-band write. */
  suspend(): void;
  /** Repaint the prompt + in-progress draft right after the write. */
  resume(): void;
}

let activeOutputGuard: OutputLineGuard | null = null;

/**
 * Register (or clear, with `null`) the guard that brackets out-of-band
 * writes. Installed by {@link writeOut}/{@link writeErr} consumers — in
 * practice the CLI's readline input reader — only while a prompt is live.
 * Idempotent; the most recent caller wins.
 */
export function setOutputLineGuard(guard: OutputLineGuard | null): void {
  activeOutputGuard = guard;
}

/**
 * Stream-agnostic write primitive. Returns `false` when the stream is
 * missing or doesn't expose `write` so callers can degrade silently under
 * hostile host environments (closed pipe, mock injects `null`, test
 * replaces the stream with a stub).
 *
 * When an {@link OutputLineGuard} is installed (a readline prompt is on
 * screen) the write is bracketed by `suspend()`/`resume()` so the user's
 * half-typed input survives the interruption instead of being stranded in
 * scrollback. The guard's own redraw uses raw stream writes — never
 * `writeOut`/`writeErr` — so there is no re-entrancy here.
 *
 * **Not exported in the public API.** Exposed only inside `term.ts` for
 * `writeOut` / `writeErr` to share a single implementation. If a caller
 * needs to write to an arbitrary stream, they should call `writeOut` (or
 * `writeErr`) with an explicit `stream` argument — the named functions
 * are the public surface so the "this is the standard error stream"
 * intent stays visible at every call site.
 */
function writeTo(s: string, stream: NodeJS.WriteStream | undefined): boolean {
  if (!stream || typeof stream.write !== 'function') return false;
  const guard = activeOutputGuard;
  if (!guard) {
    stream.write(s);
    return true;
  }
  // A prompt is live — wipe the draft row, emit the message, repaint.
  guard.suspend();
  stream.write(s);
  guard.resume();
  return true;
}

/**
 * Write `s` to `stream` (defaults to `process.stdout`). Returns `false`
 * when the stream is missing or doesn't expose `write` so callers can
 * degrade silently under hostile host environments (closed pipe, mock
 * injects `null`, test replaces the stream with a stub).
 *
 * Why a helper:
 *   1. **Single seam for output capture in tests** — stub `writeOut` once
 *      and assert on what the rest of the codebase intended to print,
 *      without spying on `process.stdout.write` (which is brittle and
 *      leaks across parallel test files).
 *   2. **Stream swap without grep** — routing the CLI's output to a
 *      logger or `out.log` becomes a one-line change at process boot.
 *   3. **Defensive default** — closes the "what if `process.stdout` is
 *      `null`" gap that currently exists at ~50 call sites that just
 *      call `process.stdout.write(s)` and crash on certain Windows
 *      redirect invocations.
 *
 * Call-site migration is staged: this commit introduces the helper, a
 * follow-up commit replaces the 50+ `process.stdout.write(...)` sites
 * with `writeOut(...)`. Until that migration lands, both forms coexist
 * and `writeOut` is the preferred form for new code.
 */
export function writeOut(s: string, stream: NodeJS.WriteStream = process.stdout): boolean {
  return writeTo(s, stream);
}

/**
 * Symmetric partner of `writeOut` for the standard error stream. Same shape,
 * same defensive contract, same single-seam-for-tests story — just defaults to
 * `process.stderr` instead of `process.stdout`.
 *
 * Use this in code paths that emit error/diagnostic/warning text. Keeping
 * these two helpers split (rather than a single `writeTo(s, stream)`) means
 * the call site reads as a clear intent signal: "I am writing an error" vs.
 * "I am writing a result" — which matters for callers that decide between
 * stdout/stderr routing (e.g. `--quiet` flags, log-level filtering,
 * structured-log rewriters that fork on stream).
 *
 * Stderr writes from the core logger (see `infrastructure/logger.ts`) and from
 * the TUI guard (see `tui/run-tui.ts`) used to call `process.stderr.write`
 * directly. Routing them through this helper lets tests stub the stream at
 * one boundary and lets future logging middleware (e.g. a JSON-line rewriter)
 * swap the destination for the entire process in one place.
 */
export function writeErr(s: string, stream: NodeJS.WriteStream = process.stderr): boolean {
  return writeTo(s, stream);
}

// ─────────────────────────────────────────────────────────────────────────────
// TerminalCapability — startup capability profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Color depth the terminal can render.
 *
 *   0 = no color (dumb, redirected, `TERM=dumb`)
 *   1 = 16 colors  (basic ANSI)
 *   2 = 256 colors (ANSI 256 + bright variants)
 *   3 = 16.7M / 24-bit truecolor
 */
export type ColorDepth = 0 | 1 | 2 | 3;

/**
 * Mouse tracking protocol the terminal speaks.
 *
 *   'none' — no mouse reporting
 *   'x10'  — basic button press/release, capped at 223 columns
 *   'urxvt'— URXVT extension, supports >223 cols
 *   'sgr'  — SGR extended mode, modern standard, no column cap
 */
export type MouseProtocol = 'none' | 'x10' | 'urxvt' | 'sgr';

/**
 * A snapshot of the terminal's capabilities and identity, computed once at
 * startup. Call {@link detectTerminal} once and pass the result through your
 * app — never re-detect mid-session.
 *
 * Query once → adapt once. Re-querying on every render is wrong because
 * `$TERM` is static for the process lifetime and stdout.isTTY can only go
 * from true→false (never the reverse), so a mid-session change means the
 * process was started in a terminal and then something went wrong.
 */
export interface TerminalCapability {
  /** True when both stdin and stdout are attached to a terminal. */
  isRealTTY: boolean;
  /**
   * Whether the terminal speaks color.
   *
   * Uses the industry-standard precedence:
   *   `FORCE_COLOR=0`  → 0 (disabled)
   *   `FORCE_COLOR`    → 3 (force truecolor)
   *   `NO_COLOR=…`     → 0 (opted out)
   *   `COLORTERM=truecolor|24bit` → 3
   *   `TERM=…truecolor|24bit`    → 3 (some emulators advertise it)
   *   `TERM=…256color`           → 2
   *   fallback                      → 1
   *
   * Note: `TERM=dumb` always produces 0 even if `COLORTERM=truecolor` is set —
   * `dumb` terminals are non-interactive by definition.
   */
  colorDepth: ColorDepth;
  /**
   * Whether `stdout` can be written to. Determined once at startup from
   * `stdout?.isTTY ?? false`. Even when `isRealTTY` is true, `stdout` may be
   * writable=false (e.g. the terminal was closed mid-session).
   */
  stdoutWritable: boolean;
  /**
   * Best mouse protocol the terminal speaks. Progressive enhancement:
   * attempt SGR first, fall back to URXVT, then X10, then 'none'.
   *
   * The caller (typically the App component) decides whether to enable
   * tracking at all — this only reports what the terminal CAN understand.
   */
  mouseProtocol: MouseProtocol;
  /**
   * Whether the terminal title can be set via OSC 0 / OSC 2.
   * True when stdout is a TTY and `$TERM` is not `dumb`.
   */
  canSetTitle: boolean;
  /**
   * Whether the terminal understands the tmux DCS passthrough prefix.
   * Detected by seeing `$TERM=tmux*`. When true, escape sequences should be
   * wrapped: `\x1bPtmux;\x1b${seq}\x1b\\`.
   */
  isTmux: boolean;
  /**
   * Whether the terminal is on Windows using the legacy conhost backend
   * (cmd.exe, PowerShell non-ConPTY) rather than ConPTY (Windows Terminal,
   * VS Code Integrated Terminal). Used to apply Windows-specific raw-mode
   * handoff logic.
   *
   * Detected by: platform === 'win32' AND `!process.stdout.getColorDepth?.()`
   * (ConPTY exposes color depth; conhost does not). Also false on non-Windows.
   */
  isWindowsConhost: boolean;
}

/**
 * Parse `process.env.TERM` into a color-depth guess.
 *
 * We intentionally do NOT use the `supports-color` npm package here because
 * (a) it adds a dependency, (b) it resolves at module-import time, and (c) we
 * need to factor in `FORCE_COLOR` / `NO_COLOR` which may be set after import.
 * This pure function is trivial to test and predictable regardless of import
 * order.
 */
function parseColorDepth(env: {
  FORCE_COLOR?: string;
  NO_COLOR?: string;
  COLORTERM?: string;
  TERM?: string;
}): ColorDepth {
  // `FORCE_COLOR=0` is an explicit opt-out, even when `COLORTERM=truecolor`.
  if (env.FORCE_COLOR === '0') return 0;
  // `FORCE_COLOR` with no value or any truthy value forces truecolor.
  if (env.FORCE_COLOR !== undefined) return 3;
  // Explicit user opt-out.
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return 0;
  // Explicit terminal advertisement.
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  // TERM strings that advertise rich color.
  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('truecolor') || term.includes('24bit')) return 3;
  if (term.includes('256color')) return 2;
  // TERM=dumb = no interactive capability at all.
  if (term === 'dumb') return 0;
  // Default to 16-color — the safest floor. Modern terminals all override this.
  return 1;
}

/**
 * Detect the best mouse protocol the terminal speaks.
 *
 * Uses the `$TERM` string as a proxy since Node.js has no runtime query for
 * mouse capability (DECSET 1000/1002/1003 responses are not standardized for
 * programmatic use). The approximation is:
 *   - `tmux` + `screen` = SGR (they proxy it)
 *   - `xterm*`, `rxvt*`, `konsole`, `gnome*` = SGR (post-2013)
 *   - `linux`, `vt100`, `dumb` = none
 *   - Everything else = URXVT / X10 (try SGR, fall back gracefully in mouse.ts)
 *
 * This is advisory only. The App component gates mouse tracking behind an
 * explicit user/setting opt-in; false positives just mean the tracking enable
 * sequence is ignored harmlessly.
 */
function parseMouseProtocol(term: string): MouseProtocol {
  const t = term.toLowerCase();
  // Terminals that reliably support SGR (1006) mode.
  if (
    t.startsWith('xterm') ||
    t.startsWith('tmux') ||
    t.startsWith('screen') ||
    t.includes('rxvt-unicode') ||
    t.includes('urxvt') ||
    t.includes('konsole') ||
    t.includes('gnome') ||
    t.includes('foot') ||
    t.includes('alacritty') ||
    t.includes('wezterm') ||
    t.includes('kitty') ||
    t.includes('vscode') ||
    t.includes('Apple_Terminal')
  ) {
    return 'sgr';
  }
  // Known mouse-capable but older terminals.
  if (t.startsWith('rxvt') || t.startsWith('linux') || t.includes('Eterm')) {
    return 'urxvt';
  }
  // vt100 / dumb — no mouse.
  if (t === 'vt100' || t === 'dumb') return 'none';
  // Default: assume SGR is safe to try; mouse.ts falls back silently.
  return 'sgr';
}

/**
 * Detect the terminal's capabilities and identity at startup.
 *
 * Call once, early in process boot, before any event-loop async has had a
 * chance to corrupt the read of `process.stdout.isTTY`. Store the result and
 * pass it through the app — do NOT call this on every render.
 *
 * All `env` lookups default gracefully to safe values when the env var is
 * absent or empty, so the return value is deterministic regardless of what
 * the host's environment looks like.
 */
export function detectTerminal(
  opts: {
    stdin?: NodeJS.ReadStream | null;
    stdout?: NodeJS.WriteStream | null;
    env?: typeof process.env;
  } = {},
): TerminalCapability {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;

  const isRealTTY = (stdin?.isTTY ?? false) && (stdout?.isTTY ?? false);
  const stdoutWritable = isRealTTY && typeof stdout?.write === 'function';
  const term = env.TERM ?? '';
  const isTmux = term.toLowerCase().startsWith('tmux');
  const isWindowsConhost =
    isRealTTY &&
    process.platform === 'win32' &&
    typeof (stdout as NodeJS.WriteStream & { getColorDepth?: unknown }).getColorDepth !==
      'function';

  return {
    isRealTTY,
    colorDepth: isRealTTY ? parseColorDepth(env) : 0,
    stdoutWritable,
    mouseProtocol: parseMouseProtocol(term),
    canSetTitle: isRealTTY && term !== 'dumb',
    isTmux,
    isWindowsConhost,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TerminalLifecycle — raw-mode lifecycle manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle owner for the TTY stdin raw-mode state machine.
 *
 * Raw mode is the most dangerous primitive in TUI code. Getting it wrong leaves
 * the user's terminal in a broken state (line-buffered, no echo) that requires
 * closing and reopening the terminal to recover. This class enforces a strict
 * acquire → hold → release lifecycle:
 *
 *   - `acquire()` may be called only once (idempotent — subsequent calls no-op).
 *   - `release()` restores the previous mode exactly once.
 *   - `release()` is called automatically on process `exit` and `beforeExit`.
 *   - Any signal handler (SIGINT, SIGTERM, SIGHUP) that calls `release()` clears
 *     its own registration so double-signals don't double-restore.
 *
 * Use this instead of calling `setRawMode()` directly at every call site. The
 * single instance lives at module scope in `run-tui.ts`; components that need
 * to signal "TUI is shutting down" call `terminalLifecycle.requestExit()` rather
 * than calling `release()` directly.
 */
export class TerminalLifecycle {
  private _active = false;

  /**
   * The stdin stream we took raw mode on. Set by `acquire()`; undefined before
   * first call. Used by `release()` and by the ConPTY race-closer in
   * `acquire()`.
   */
  private _stdin: NodeJS.ReadStream | undefined;

  /**
   * The `isRaw` snapshot captured before the first `acquire()` call, so
   * `release()` restores to the pre-TUI state rather than blindly disabling
   * raw mode. Null when `acquire()` has never been called.
   */
  private _wasRaw: boolean | null = null;

  /**
   * Whether stdin was paused before the TUI took ownership. Readline closes
   * its interface by pausing the shared process stream, so raw mode alone is
   * not enough to make Ink receive bytes during the boot-prompt -> TUI handoff.
   */
  private _wasPaused: boolean | null = null;

  /**
   * Request the process to exit. Set the flag, trigger any registered
   * `onRequestExit` callback (typically Ink's `unmount()`), and arm a
   * deadline timer.  When the timer fires the process is hard-exited.
   *
   * Safe to call multiple times: subsequent calls no-op after the first.
   */
  requestExit: (exitCode?: number) => void;

  /**
   * Callback invoked when `requestExit` is called. Registered by the Ink
   * mount point so unmount() runs before the deadline timer fires.
   */
  onRequestExit: (() => void | Promise<void>) | null = null;

  constructor() {
    // Build the requestExit closure here so subclasses / tests can override
    // `requestExit` before calling `acquire()`.
    let exitCode = 0;
    let requested = false;
    this.requestExit = (code = 0) => {
      exitCode = code;
      if (requested) return;
      requested = true;
      // Let the Ink unmount handler run (if registered).
      try {
        this.onRequestExit?.();
      } catch {
        // unmount handler threw — proceed to hard exit.
      }
      // Hard-exit deadline. `unref()` so the timer doesn't keep the event
      // loop alive if everything else has settled.
      setTimeout(() => process.exit(exitCode), 5_000).unref();
    };
  }

  /** True while raw mode is held. */
  get active(): boolean {
    return this._active;
  }

  /**
   * Acquire raw mode on `stdin`. Idempotent — calling twice is safe; only the
   * first call has any effect.
   *
   * On Windows ConPTY, calls `setRawMode` twice: once immediately, then again
   * after the next event-loop tick. This closes the ConPTY race where
   * `readline`'s cleanup (registered before this class is constructed) can
   * restore the original cooked mode after we set raw mode but before Ink's
   * render loop takes over the stdin fd. The double-call ensures the last
   * writer wins.
   *
   * @param stdin - The stdin stream (defaults to `process.stdin`).
   * @returns `true` if raw mode was acquired; `false` if stdin is not a TTY
   *          or already shut down.
   */
  acquire(stdin: NodeJS.ReadStream = process.stdin): boolean {
    if (this._active) return false;

    // Guard: must be a real TTY, must have setRawMode.
    if (stdin?.isTTY !== true) return false;
    if (typeof stdin.setRawMode !== 'function') return false;

    // Snapshot the pre-TUI raw state so release() restores correctly.
    this._wasRaw = stdin.isRaw ?? false;
    this._wasPaused = stdin.isPaused();
    this._stdin = stdin;

    stdin.setRawMode(true);
    // A preceding readline prompt normally leaves process.stdin paused.
    // Explicitly start the stream before Ink installs its input listener;
    // otherwise the UI can render perfectly while every key appears dead.
    stdin.resume();
    this._active = true;

    // Windows ConPTY double-acquire: schedule a second setRawMode on the next
    // tick so we win the race against readline's "restore original mode".
    // Safe on non-Windows (no-op: process.platform !== 'win32').
    if (process.platform === 'win32') {
      setImmediate(() => {
        if (this._active && this._stdin?.isTTY) {
          this._stdin.setRawMode?.(true);
        }
      });
    }

    return true;
  }

  /**
   * Release raw mode and restore the terminal to the state it was in before
   * `acquire()` was called. Idempotent — subsequent calls are no-ops.
   *
   * Call this on: SIGINT, SIGTERM, SIGHUP, SIGBREAK, and `process.exit`.
   *
   * ⚠ **Windows caveat**: `setRawMode(false)` on ConPTY restores the original
   * console mode captured when the process started — not the mode captured by
   * `acquire()`. On ConPTY, the original mode was already raw (ConPTY starts
   * raw), so this call is typically a no-op on Windows Terminal. On conhost.exe
   * it may restore cooked mode, which is correct for that backend.
   */
  release(): void {
    if (!this._active) return;
    this._active = false;

    const stdin = this._stdin;
    if (stdin?.isTTY === true) {
      // Restore to pre-TUI state rather than blindly disabling raw mode.
      stdin.setRawMode?.(this._wasRaw ?? false);
      if (this._wasPaused) stdin.pause();
    }
    this._stdin = undefined;
    this._wasRaw = null;
    this._wasPaused = null;
  }

  /**
   * Synchronously reset all terminal state written by the TUI layer:
   * raw mode, SGR attributes, cursor visibility, and mouse tracking.
   *
   * Intended for the final `process.on('exit')` handler where async is
   * impossible. Uses `\x1b[0m` (SGR reset), `\x1b[?25h` (cursor show),
   * and `\x1b[?9l` (mouse off) — all safe to emit even if the terminal does
   * not understand them (unknown CSI sequences are silently ignored).
   *
   * Safe to call multiple times from multiple exit paths because each write
   * is a constant-time synchronous stream write.
   *
   * @param stdout - Stream to reset (defaults to `process.stdout`).
   */
  reset(stdout: NodeJS.WriteStream = process.stdout): void {
    if (typeof stdout?.write !== 'function') return;
    // SGR reset — clears bold, color, underline, etc.
    stdout.write('\x1b[0m');
    // Cursor show (in case Ink's unmount left it hidden).
    stdout.write('\x1b[?25h');
    // Mouse tracking off (all three DECRST sequences — safe no-ops if never set).
    stdout.write('\x1b[?1003l\x1b[?1002l\x1b[?1000l');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// safeEscape — guarded escape-sequence emitter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of emitting an escape sequence. Distinguishes the three distinct
 * failure modes so callers can degrade gracefully.
 */
export interface EscapeEmitResult {
  /** `true` when the sequence was written to the stream. */
  ok: boolean;
  /**
   * Human-readable reason when `ok` is `false`. One of:
   *   `'not_a_tty'`   — stdout is not a terminal (pipe / redirect / CI)
   *   `'unwritable'`  — stdout.write is missing or threw
   *   `'empty'`       — `sequence` was the empty string
   */
  reason: 'not_a_tty' | 'unwritable' | 'empty';
}

/**
 * A terminal escape sequence with its optional string terminator.
 *
 * OSC (title, color palette) sequences MUST be terminated with `BEL (\x07)`
 * or `ST (\x1b\\)` or the terminal stays in command mode and corrupts
 * subsequent output. CSI sequences (colors, cursor movement) are
 * self-terminating and do not need a terminator byte.
 */
export interface EscapeSequence {
  /** The raw sequence, e.g. `\x1b[38;2;255;0;0m`. */
  raw: string;
  /**
   * Optional terminator byte required by OSC/DCS families.
   * `undefined` for CSI sequences; `\x07` (BEL) for OSC; `\x1b\\` (ST) for DCS.
   */
  terminator?: string;
}

/**
 * Shared OSC/DCS terminator bytes.
 *
 * BEL (`\x07`) is understood by iTerm2, Konsole, mintty, foot, and
 * Windows Terminal. ST (`\x1b\\`) is the strict DEC standard equivalent.
 * Prefer BEL for compatibility; fall back to ST if the terminal's response
 * to BEL is observed to be garbled.
 */
export const ESCAPE_TERMINATOR = Object.freeze({
  BEL: '\x07', // OSC 0 / OSC 2 (title)
  ST: '\x1b\\', // DCS / strict OSC
});

/**
 * Emit a terminal escape sequence safely.
 *
 * Rules enforced:
 *   1. Empty string → returns `ok: false, reason: 'empty'`, no write.
 *   2. Not a TTY    → returns `ok: false, reason: 'not_a_tty'`, no write.
 *   3. Stream write throws → returns `ok: false, reason: 'unwritable'`.
 *   4. OSC/DCS sequences MUST have a terminator byte (guarded assertion).
 *      A missing terminator on an OSC sequence corrupts output on terminals
 *      that don't understand the sequence — this function refuses to emit it.
 *
 * @param sequence - The sequence to emit. CSI sequences need no terminator.
 *                   OSC/DCS sequences must carry `terminator: '\x07'` or `'\x1b\\'`.
 * @param stdout   - Stream to write to (defaults to `process.stdout`).
 * @returns Result indicating success or the specific failure mode.
 */
export function safeEmit(
  sequence: EscapeSequence | string,
  stdout: NodeJS.WriteStream = process.stdout,
): EscapeEmitResult {
  const raw = typeof sequence === 'string' ? sequence : sequence.raw;
  const term = typeof sequence === 'string' ? undefined : sequence.terminator;

  if (!raw) {
    return { ok: false, reason: 'empty' };
  }
  if (stdout?.isTTY !== true) {
    return { ok: false, reason: 'not_a_tty' };
  }

  // For OSC/DCS sequences (which include `[` or `]` in the body), verify a
  // terminator is present.  CSI sequences start with `\x1b[` and are
  // self-terminating; we treat any sequence that is not a known OSC/DCS
  // as CSI and allow through.  OSC starts with `\x1b]`; DCS with `\x1bP`.
  if (raw.startsWith('\x1b]') || raw.startsWith('\x1bP')) {
    // Assertion: terminator must be provided. Belt-and-suspenders against
    // callers that forget to append `\x07` — this prevents corrupted output.
    if (!term) {
      // Defensive: append BEL rather than crashing.  This is the only case
      // where we mutate the sequence.  The assert-then-fallback pattern is
      // intentional: we catch programmer error in development but degrade
      // safely in production rather than throwing.
      void term; // suppress unused-variable warning
      const safe = `${raw}\x07`;
      try {
        stdout.write(safe);
      } catch {
        return { ok: false, reason: 'unwritable' };
      }
      return { ok: true, reason: 'empty' }; // reason field is ignored when ok=true
    }
    try {
      stdout.write(`${raw}${term}`);
    } catch {
      return { ok: false, reason: 'unwritable' };
    }
    return { ok: true, reason: 'empty' };
  }

  // CSI sequence — self-terminating.
  try {
    stdout.write(raw);
  } catch {
    return { ok: false, reason: 'unwritable' };
  }
  return { ok: true, reason: 'empty' };
}

/**
 * Build an OSC 0 / OSC 2 (window/tab title) sequence with a safe terminator.
 *
 * The terminator defaults to `BEL (\x07)` for broad terminal compatibility.
 * Use `terminator: ESCAPE_TERMINATOR.ST` for stricter terminals that interpret
 * BEL as a beep.
 *
 * @param title   - The title string. Embedded BEL bytes are stripped.
 * @param terminator - Defaults to `ESCAPE_TERMINATOR.BEL`.
 */
export function buildTitleSequence(
  title: string,
  terminator: string = ESCAPE_TERMINATOR.BEL,
): EscapeSequence {
  return {
    raw: `\x1b]0;${title.replace(/\x07/g, '')}`,
    terminator,
  };
}

/**
 * Build an SGR (Select Graphic Rendition) color/style sequence.
 *
 * @param codes - SGR parameter list, e.g. `[31]` (red foreground),
 *                `[1;32]` (bold green), `[38;2;255;128;0]` (truecolor orange).
 */
export function buildSgrSequence(...codes: number[]): EscapeSequence {
  return { raw: `\x1b[${codes.join(';')}m` };
}

/**
 * Emit a title sequence.  Convenience wrapper around `safeEmit` + `buildTitleSequence`.
 *
 * @param title - The title string.
 * @param stdout - Target stream.
 */
export function setTitle(title: string, stdout: NodeJS.WriteStream = process.stdout): boolean {
  return safeEmit(buildTitleSequence(title), stdout).ok;
}
