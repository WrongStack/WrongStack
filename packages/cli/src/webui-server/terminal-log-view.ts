import { format } from 'node:util';

const DEFAULT_BUFFER_LINES = 200;

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleTarget {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
  debug: ConsoleMethod;
}

/**
 * Progress chatter the browser already owns. `[WebUI] Tool registry
 * loaded`, `[WebUI] Session created`, watcher metrics — none of it is
 * actionable from a terminal whose only job is to host the server.
 */
const MUTED_LEVELS = ['log', 'info', 'debug'] as const;

/**
 * Failures always reach the terminal. A silently swallowed error is a far
 * worse outcome than a noisy one, so quiet mode never touches these.
 */
const FORWARDED_LEVELS = ['warn', 'error'] as const;

export interface QuietSurfaceConsoleOptions {
  isTTY?: boolean | undefined;
  /** Pass everything through untouched (the `WEBUI_VERBOSE=1` escape hatch). */
  verbose?: boolean | undefined;
  consoleTarget?: ConsoleTarget | undefined;
  /** Ring-buffer size for {@link QuietSurfaceConsole.recent}. */
  bufferLines?: number | undefined;
}

export interface QuietSurfaceConsole {
  /** `false` when the console was left untouched (non-TTY or verbose). */
  readonly enabled: boolean;
  /** Chatter lines dropped from the terminal so far. */
  readonly mutedCount: number;
  /** Newest muted lines, oldest first — for a diagnostic dump on failure. */
  recent(): readonly string[];
  stop(): void;
}

const DISABLED: QuietSurfaceConsole = {
  enabled: false,
  mutedCount: 0,
  recent: () => [],
  stop: () => {},
};

function envVerbose(): boolean {
  for (const name of ['WEBUI_VERBOSE', 'WRONGSTACK_WEBUI_VERBOSE']) {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  }
  return false;
}

/**
 * Keep an interactive WebUI/SimpleUI terminal quiet while the browser owns
 * the output surface.
 *
 * Two things fill that terminal, and this handles both:
 *
 *   - **Chatter.** Every `console.log`/`info`/`debug` from the server is
 *     progress the browser already shows. Those are dropped from the
 *     terminal (still counted, and the newest are kept in memory for a
 *     failure dump); `console.warn`/`error` are forwarded untouched.
 *
 *   - **Repetition.** A warning that fires on a timer used to append an
 *     identical line every tick until the terminal was pages deep in the
 *     same text. Consecutive identical lines now collapse into a single
 *     `↑ previous line repeated N×` notice emitted when the streak ends.
 *
 * Non-TTY output is deliberately untouched so redirected output and log
 * collectors retain the complete append-only log, as is `WEBUI_VERBOSE=1`.
 */
export function startQuietSurfaceConsole(
  options: QuietSurfaceConsoleOptions = {},
): QuietSurfaceConsole {
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const verbose = options.verbose ?? envVerbose();
  if (!isTTY || verbose) return DISABLED;

  const bufferLines = Math.max(1, Math.trunc(options.bufferLines ?? DEFAULT_BUFFER_LINES));
  const target = options.consoleTarget ?? console;
  const muted: string[] = [];
  let mutedCount = 0;
  let stopped = false;

  // Repeat collapsing state. `lastEmit` is the method that printed
  // `lastLine`, so the "repeated N×" notice lands on the same stream.
  let lastLine: string | null = null;
  let lastEmit: ConsoleMethod | null = null;
  let repeats = 0;

  const originals = {
    log: target.log,
    info: target.info,
    warn: target.warn,
    error: target.error,
    debug: target.debug,
  } satisfies Record<keyof ConsoleTarget, ConsoleMethod>;
  const wrappers = {} as Record<keyof ConsoleTarget, ConsoleMethod>;

  const flushRepeats = (): void => {
    if (repeats === 0 || !lastEmit) return;
    const count = repeats;
    repeats = 0;
    lastEmit.call(target, `  ↑ previous line repeated ${count}×`);
  };

  for (const level of MUTED_LEVELS) {
    const wrapper: ConsoleMethod = (...args) => {
      mutedCount += 1;
      muted.push(format(...args));
      if (muted.length > bufferLines) muted.shift();
    };
    wrappers[level] = wrapper;
    target[level] = wrapper;
  }

  for (const level of FORWARDED_LEVELS) {
    const original = originals[level];
    const wrapper: ConsoleMethod = (...args) => {
      const line = format(...args);
      if (line === lastLine) {
        repeats += 1;
        return;
      }
      flushRepeats();
      lastLine = line;
      lastEmit = original;
      original.apply(target, args);
    };
    wrappers[level] = wrapper;
    target[level] = wrapper;
  }

  return {
    enabled: true,
    get mutedCount() {
      return mutedCount;
    },
    recent: () => [...muted],
    stop: () => {
      if (stopped) return;
      stopped = true;
      flushRepeats();
      for (const level of Object.keys(originals) as Array<keyof ConsoleTarget>) {
        if (target[level] === wrappers[level]) target[level] = originals[level];
      }
    },
  };
}
