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
 * Where the emulator that paints our output actually runs.
 *
 *   'native'  — a desktop terminal process on this machine (Windows Terminal,
 *               iTerm2, kitty, Alacritty, …)
 *   'browser' — a browser/webview emulator (xterm.js family): VS Code's
 *               integrated terminal, code-server / openvscode-server,
 *               GitHub Codespaces, Gitpod, Theia, Jupyter, Cloud Shell,
 *               Replit, and self-hosted web terminals (ttyd, gotty, wetty)
 *
 * The distinction is not cosmetic. Browser emulators paint with a *CSS* font
 * stack chosen by the page rather than by the process, never implement the
 * Kitty Graphics or iTerm2 `OSC 1337` image protocols, and are frequently
 * attached to a client that is a different machine entirely — so any
 * server-side font scan describes a machine the user is not looking at.
 */
export type TerminalHost = 'native' | 'browser';

export interface TerminalHostInfo {
  host: TerminalHost;
  /**
   * Recognized surface name (`vscode`, `windows-terminal`, `kitty`, `tmux`, …),
   * or `null` when the terminal identity is unknown or forced by env override.
   */
  kind: string | null;
  /**
   * True when glyph/colour discovery performed on this machine cannot
   * describe the surface the user is looking at (the browser client is
   * elsewhere: SSH session, hosted workspace, Jupyter server, …).
   */
  remoteClient: boolean;
}

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
   * A recognized modern surface takes precedence over missing Node stream
   * helpers (Bun need not expose getColorDepth). An unidentified Windows TTY
   * without that helper takes the conservative legacy path.
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
  /**
   * Whether the painting surface is a native terminal or a browser/webview
   * emulator, plus whether the client is remote. See {@link detectTerminalHost}.
   */
  terminalHost: TerminalHostInfo;
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

/**
 * Browser/webview terminals that set an unambiguous environment marker.
 *
 * Only markers the terminal itself (or its hosting platform) exports are used —
 * never a heuristic on `$TERM`, which browser emulators commonly report as
 * `xterm-256color` exactly like a native emulator.
 */
interface BrowserHostSignal {
  kind: string;
  /** The browser client is a different machine than this process. */
  remoteClient: boolean;
}

const VSCODE_FAMILY_PROGRAMS = new Set(['vscode', 'vscode-insiders', 'visual studio code']);

const NATIVE_TERMINAL_PROGRAMS = new Map([
  ['wezterm', 'wezterm'],
  ['kitty', 'kitty'],
  ['ghostty', 'ghostty'],
  ['alacritty', 'alacritty'],
  ['iterm.app', 'iterm2'],
  ['apple_terminal', 'apple-terminal'],
  ['warpterminal', 'warp'],
  ['rio', 'rio'],
  ['mintty', 'mintty'],
  ['tmux', 'tmux'],
  ['screen', 'screen'],
]);

function detectNativeTerminalKind(env: typeof process.env): string | null {
  const term = (env.TERM ?? '').trim().toLowerCase();
  // The immediate multiplexer wins over markers inherited from its launcher.
  if (env.TMUX || term.startsWith('tmux')) return 'tmux';
  if (env.STY || term.startsWith('screen')) return 'screen';
  const program = (env.TERM_PROGRAM ?? '').trim().toLowerCase();
  if (program) return NATIVE_TERMINAL_PROGRAMS.get(program) ?? null;
  if (env.LC_TERMINAL?.trim().toLowerCase() === 'iterm2') return 'iterm2';
  if (term === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty';
  if (term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (term === 'wezterm' || env.WEZTERM_PANE) return 'wezterm';
  if (term === 'alacritty' || env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return 'alacritty';
  if (env.WT_SESSION) return 'windows-terminal';
  return null;
}

function detectBrowserHostSignal(env: typeof process.env): BrowserHostSignal | null {
  const has = (key: string): boolean => {
    const value = env[key];
    return typeof value === 'string' && value.trim() !== '';
  };

  if (has('CODESPACE_NAME') || env.CODESPACES === 'true') {
    return { kind: 'codespaces', remoteClient: true };
  }
  if (has('GITPOD_WORKSPACE_ID') || has('GITPOD_WORKSPACE_URL')) {
    return { kind: 'gitpod', remoteClient: true };
  }
  if (has('OPENVSCODE_SERVER_ROOT')) {
    return { kind: 'code-server', remoteClient: true };
  }
  if (has('THEIA_WORKSPACE_ROOT') || env.TERM_PROGRAM?.trim().toLowerCase() === 'theia') {
    return { kind: 'theia', remoteClient: true };
  }
  if (env.CLOUD_SHELL === 'true') {
    return { kind: 'cloud-shell', remoteClient: true };
  }
  if (has('REPL_ID') || has('REPL_OWNER') || has('REPLIT_DEV_DOMAIN')) {
    return { kind: 'replit', remoteClient: true };
  }
  if (has('JPY_PARENT_PID') || has('JUPYTER_SERVER_ROOT')) {
    return { kind: 'jupyter', remoteClient: true };
  }
  // JetBrains terminals (JediTerm) render with the IDE's configured font, never
  // a font the shell can inspect — the same structural problem as a webview.
  if (env.TERMINAL_EMULATOR?.trim().toLowerCase() === 'jetbrains-jediterm') {
    return { kind: 'jetbrains', remoteClient: true };
  }
  if (has('CODER_WORKSPACE_ID') || has('CODER_AGENT_URL')) {
    return { kind: 'coder', remoteClient: true };
  }
  if (has('C9_USER') || has('C9_PROJECT')) {
    return { kind: 'cloud9', remoteClient: true };
  }
  if (env.BROWSER_TERMINAL?.trim() === '1' || env.BROWSER_TERMINAL?.toLowerCase() === 'true') {
    return { kind: 'browser', remoteClient: true };
  }

  const termProgram = (env.TERM_PROGRAM ?? '').trim().toLowerCase();
  if (VSCODE_FAMILY_PROGRAMS.has(termProgram)) {
    // Its webview owns the configured font even on a local desktop. Host-side
    // installed fonts do not identify the font this surface actually paints.
    return { kind: 'vscode', remoteClient: false };
  }
  if (termProgram === 'hyper' || termProgram === 'tabby') {
    return { kind: termProgram, remoteClient: false };
  }
  return null;
}

/**
 * Detect whether the emulator painting our output is a browser/webview surface.
 *
 * Detection is env-only because there is no programmatic query for "am I inside
 * xterm.js". Unknown/absent markers resolve to `native`, which keeps the
 * existing native behaviour untouched. `WRONGSTACK_TUI_TERMINAL=browser|native`
 * is the explicit escape hatch for self-hosted web terminals (ttyd, gotty,
 * wetty) that export no marker of their own.
 */
export function detectTerminalHost(
  env: typeof process.env = process.env,
  isRemoteSSH: boolean = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY),
): TerminalHostInfo {
  const override = env.WRONGSTACK_TUI_TERMINAL?.trim().toLowerCase();
  if (override === 'native') return { host: 'native', kind: null, remoteClient: isRemoteSSH };
  if (override === 'browser' || override === 'web' || override === 'xterm') {
    return { host: 'browser', kind: null, remoteClient: true };
  }

  const signal = detectBrowserHostSignal(env);
  if (!signal)
    return { host: 'native', kind: detectNativeTerminalKind(env), remoteClient: isRemoteSSH };
  return {
    host: 'browser',
    kind: signal.kind,
    remoteClient: signal.remoteClient || isRemoteSSH,
  };
}

/**
 * Browser/webview emulators (xterm.js family) render 24-bit colour regardless of
 * whether the shell inherited `COLORTERM`. ttyd, gotty and wetty commonly launch
 * a shell with only `TERM=xterm-256color`, which would otherwise demote the
 * image preview to a text card even though a truecolor half-block mosaic renders
 * fine. Explicit opt-outs survive: `parseColorDepth` already returns 0 for
 * `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb` and non-TTY output, so only a real
 * 16/256-colour guess (1 or 2) is promoted.
 */
function resolveBrowserColorDepth(
  colorDepth: ColorDepth,
  isRealTTY: boolean,
  host: TerminalHostInfo,
): ColorDepth {
  if (host.host !== 'browser' || !isRealTTY) return colorDepth;
  return colorDepth >= 1 ? 3 : colorDepth;
}

function parseGraphicsProtocol(
  isRealTTY: boolean,
  isWindowsConhost: boolean,
  isTmux: boolean,
  colorDepth: ColorDepth,
  term: string,
  env: typeof process.env,
  host: TerminalHostInfo,
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

  // Browser/webview emulators never implement Kitty Graphics or iTerm2
  // `OSC 1337` images; emitting those escapes there paints literal base64
  // garbage into the screen. Degrade to truecolor half-blocks, which every
  // xterm.js build renders correctly. An explicit WRONGSTACK_TUI_GRAPHICS
  // selection was already honoured above.
  if (host.host === 'browser') return colorDepth >= 3 ? 'halfblock' : 'none';

  // Inside tmux, raw APC/OSC image payloads are dropped unless the user enabled
  // `allow-passthrough` in tmux.conf. Default to truecolor half-block cells
  // unless passthrough is explicitly opted in.
  if (isTmux && env.WRONGSTACK_TUI_TMUX_PASSTHROUGH !== '1') {
    return colorDepth >= 3 ? 'halfblock' : 'none';
  }

  if (!isTmux) {
    // Use the immediate surface's identity. A terminal launched from Kitty
    // may inherit KITTY_WINDOW_ID even though it cannot paint Kitty images.
    const kind = host.kind ?? detectNativeTerminalKind(env);
    if (kind === 'kitty' || kind === 'ghostty') return 'kitty';
    if (
      kind === 'wezterm' ||
      kind === 'iterm2' ||
      kind === 'warp' ||
      kind === 'rio' ||
      kind === 'mintty'
    )
      return 'iterm2';
    return colorDepth >= 3 ? 'halfblock' : 'none';
  }

  // Only explicit tmux passthrough may consult the outer emulator's markers.
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
  const terminalHost = detectTerminalHost(env);
  const isTmux = terminalHost.kind === 'tmux' || term.toLowerCase().startsWith('tmux');
  const isWindowsConhost =
    isRealTTY &&
    process.platform === 'win32' &&
    terminalHost.host !== 'browser' &&
    terminalHost.kind === null &&
    typeof (stdout as NodeJS.WriteStream & { getColorDepth?: unknown }).getColorDepth !==
      'function';
  const colorDepth: ColorDepth = resolveBrowserColorDepth(
    isRealTTY ? parseColorDepth(env) : 0,
    isRealTTY,
    terminalHost,
  );

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
      terminalHost,
    ),
    terminalHost,
  };
}
