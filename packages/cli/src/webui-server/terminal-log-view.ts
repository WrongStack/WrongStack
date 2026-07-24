import { format } from 'node:util';

const DEFAULT_MAX_LINES = 5;
const DEFAULT_REFRESH_MS = 5_000;
const CLEAR_VISIBLE_TERMINAL = '\x1b[2J\x1b[H';

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleTarget {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
  debug: ConsoleMethod;
}

export interface BoundedTerminalLogViewOptions {
  maxLines?: number | undefined;
  refreshMs?: number | undefined;
  isTTY?: boolean | undefined;
  consoleTarget?: ConsoleTarget | undefined;
  write?: ((chunk: string) => void) | undefined;
  setIntervalFn?: ((callback: () => void, delay: number) => NodeJS.Timeout) | undefined;
  clearIntervalFn?: ((timer: NodeJS.Timeout) => void) | undefined;
}

export interface BoundedTerminalLogView {
  readonly enabled: boolean;
  redraw(): void;
  stop(): void;
}

/**
 * Periodically redraw an interactive WebUI/SimpleUI terminal with only its
 * newest physical log lines. Non-TTY output is deliberately untouched so
 * redirected output and log collectors retain the complete append-only log.
 */
export function startBoundedTerminalLogView(
  options: BoundedTerminalLogViewOptions = {},
): BoundedTerminalLogView {
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  if (!isTTY) {
    return { enabled: false, redraw: () => {}, stop: () => {} };
  }

  const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_MAX_LINES));
  const refreshMs = Math.max(100, Math.trunc(options.refreshMs ?? DEFAULT_REFRESH_MS));
  const target = options.consoleTarget ?? console;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const lines: string[] = [];
  let stopped = false;

  const originals: Record<keyof ConsoleTarget, ConsoleMethod> = {
    log: target.log,
    info: target.info,
    warn: target.warn,
    error: target.error,
    debug: target.debug,
  };
  const wrappers = {} as Record<keyof ConsoleTarget, ConsoleMethod>;

  const remember = (args: unknown[]): void => {
    for (const line of format(...args).split(/\r?\n/u)) {
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    }
  };

  for (const level of Object.keys(originals) as Array<keyof ConsoleTarget>) {
    const original = originals[level];
    const wrapper: ConsoleMethod = (...args) => {
      remember(args);
      original.apply(target, args);
    };
    wrappers[level] = wrapper;
    target[level] = wrapper;
  }

  const redraw = (): void => {
    if (stopped || lines.length === 0) return;
    write(`${CLEAR_VISIBLE_TERMINAL}${lines.join('\n')}\n`);
  };
  const timer = setIntervalFn(redraw, refreshMs);
  timer.unref?.();

  return {
    enabled: true,
    redraw,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      for (const level of Object.keys(originals) as Array<keyof ConsoleTarget>) {
        if (target[level] === wrappers[level]) target[level] = originals[level];
      }
    },
  };
}
