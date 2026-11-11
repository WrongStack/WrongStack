/**
 * Terminal capability detection (color depth, mouse protocol, emulator
 * identity) from the environment. Split out of term.ts.
 */

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
 * Best inline image rendering protocol supported by the attached terminal.
 *
 *   'kitty'     — Kitty graphics protocol (`APC G ... ST`, Kitty & Ghostty)
 *   'iterm2'    — iTerm2 `OSC 1337` inline images (iTerm2, WezTerm, Warp, Rio, Mintty)
 *   'halfblock' — 24-bit truecolor Unicode half-block (`▀`) cell mosaic
 *   'none'      — text metadata card only (dumb, piped, legacy conhost, frugal)
 */
export type TerminalGraphicsProtocol = 'kitty' | 'iterm2' | 'halfblock' | 'none';

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
  /**
   * Whether the terminal safely accepts DECSET 2026 synchronized output framing
   * (`\x1b[?2026h` ... `\x1b[?2026l`). Respects `WRONGSTACK_TUI_SYNC=0|1`.
   */
  supportsSyncOutput: boolean;
  /**
   * Best inline graphics protocol available on this terminal.
   * Respects `WRONGSTACK_TUI_GRAPHICS=auto|kitty|iterm2|halfblock|off`.
   */
  graphicsProtocol: TerminalGraphicsProtocol;
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
  const term = (env.TERM ?? '').toLowerCase();
  // TERM=dumb = no interactive capability at all — ahead of COLORTERM, which a
  // dumb terminal (Emacs shell) often inherits from the one that launched it.
  if (term === 'dumb') return 0;
  // Explicit terminal advertisement.
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  // TERM strings that advertise rich color.
  if (term.includes('truecolor') || term.includes('24bit')) return 3;
  if (term.includes('256color')) return 2;
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

function parseSupportsSyncOutput(
  isRealTTY: boolean,
  isWindowsConhost: boolean,
  term: string,
  env: typeof process.env,
): boolean {
  if (!isRealTTY || term.toLowerCase() === 'dumb') return false;
  const override = env.WRONGSTACK_TUI_SYNC?.trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'off') return false;
  if (override === '1' || override === 'true' || override === 'on') return true;
  return !isWindowsConhost;
}

function parseGraphicsProtocol(
  isRealTTY: boolean,
  isWindowsConhost: boolean,
  isTmux: boolean,
  colorDepth: ColorDepth,
  term: string,
  env: typeof process.env,
): TerminalGraphicsProtocol {
  const t = term.toLowerCase();
  if (!isRealTTY || t === 'dumb' || isWindowsConhost) return 'none';

  const override = env.WRONGSTACK_TUI_GRAPHICS?.trim().toLowerCase();
  if (override === '0' || override === 'false' || override === 'off' || override === 'none') {
    return 'none';
  }
  if (override === 'kitty' || override === 'iterm2' || override === 'halfblock') {
    return override;
  }

  const perfProfile = (env.WRONGSTACK_PERF_PROFILE ?? env.WSTACK_PERF_PROFILE ?? '')
    .trim()
    .toLowerCase();
  if (perfProfile === 'frugal') return 'none';

  // Inside tmux, raw APC/OSC image payloads are dropped unless the user enabled
  // `allow-passthrough` in tmux.conf. Default to truecolor half-block cells
  // unless passthrough is explicitly opted in.
  if (isTmux && env.WRONGSTACK_TUI_TMUX_PASSTHROUGH !== '1') {
    return colorDepth >= 3 ? 'halfblock' : 'none';
  }

  if (
    env.KITTY_WINDOW_ID ||
    t.includes('kitty') ||
    env.GHOSTTY_RESOURCES_DIR ||
    t.includes('ghostty')
  ) {
    return 'kitty';
  }

  const termProgram = (env.TERM_PROGRAM ?? '').trim().toLowerCase();
  const lcTerminal = (env.LC_TERMINAL ?? '').trim().toLowerCase();
  if (
    env.WEZTERM_PANE ||
    termProgram === 'wezterm' ||
    termProgram === 'iterm.app' ||
    lcTerminal === 'iterm2' ||
    termProgram === 'warpterminal' ||
    termProgram === 'rio' ||
    termProgram === 'mintty'
  ) {
    return 'iterm2';
  }

  return colorDepth >= 3 ? 'halfblock' : 'none';
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
  const colorDepth: ColorDepth = isRealTTY ? parseColorDepth(env) : 0;

  return {
    isRealTTY,
    colorDepth,
    stdoutWritable,
    mouseProtocol: parseMouseProtocol(term),
    canSetTitle: isRealTTY && term !== 'dumb',
    isTmux,
    isWindowsConhost,
    supportsSyncOutput: parseSupportsSyncOutput(isRealTTY, isWindowsConhost, term, env),
    graphicsProtocol: parseGraphicsProtocol(
      isRealTTY,
      isWindowsConhost,
      isTmux,
      colorDepth,
      term,
      env,
    ),
  };
}
