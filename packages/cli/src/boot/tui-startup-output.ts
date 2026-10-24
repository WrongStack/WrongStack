import { format, stripVTControlCharacters } from 'node:util';
import type { Logger } from '@wrongstack/contracts/types';

const LEVELS = ['log', 'info', 'debug', 'warn'] as const;
type ConsoleLevel = (typeof LEVELS)[number];
type BufferedOutput =
  | { kind: 'console'; level: ConsoleLevel; args: unknown[] }
  | { kind: 'stderr'; text: string }
  | { kind: 'warning'; args: Parameters<typeof process.emitWarning> };

export function shouldCaptureTuiStartup(
  flags: Record<string, string | boolean>,
  positional: readonly string[],
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
): boolean {
  return (
    interactive &&
    !flags['no-tui'] &&
    !flags['webui'] &&
    !flags['simpleui'] &&
    !flags['vibeui'] &&
    !flags['hq'] &&
    !flags['desktop'] &&
    !flags['remote'] &&
    !flags['no-interactive'] &&
    typeof flags['prompt'] !== 'string' &&
    (positional.length === 0 ||
      positional[0] === 'quick' ||
      (positional[0] === 'resume' && positional.length === 2))
  );
}

/** Buffer diagnostics until the launch menu decides who owns the terminal.
 * TUI logs go to its existing file logger; other surfaces replay normal output.
 * Prompts, unstructured stderr and errors remain visible throughout boot.
 */
export function startTuiStartupOutput(enabled: boolean) {
  const originals = Object.fromEntries(LEVELS.map((level) => [level, console[level]])) as Record<
    ConsoleLevel,
    typeof console.log
  >;
  const originalWrite = process.stderr.write;
  const originalWarning = process.emitWarning;
  const wrappers = {} as typeof originals;
  const buffered: BufferedOutput[] = [];
  let logger: Logger | undefined;
  let quiet = false;
  let stopped = !enabled;
  const remember = (output: BufferedOutput): void => {
    if (quiet) {
      if (output.kind === 'console') {
        const text = format(...output.args);
        const structuredLevel = recordLevel(text);
        const level =
          structuredLevel === 'warn' ||
          structuredLevel === 'info' ||
          structuredLevel === 'debug' ||
          structuredLevel === 'trace'
            ? structuredLevel
            : output.level === 'log'
              ? 'info'
              : output.level;
        logger?.[level](text, { event: 'tui.startup.console' });
      } else if (output.kind === 'warning') {
        const warning = output.args[0];
        logger?.warn(warning instanceof Error ? warning.message : String(warning), {
          event: 'tui.startup.warning',
        });
      }
      return;
    }
    buffered.push(output);
    if (buffered.length > 200) buffered.shift();
  };
  const recordLevel = (text: string): string | undefined => {
    try {
      const record: unknown = JSON.parse(text);
      if (
        record &&
        typeof record === 'object' &&
        'level' in record &&
        typeof record.level === 'string'
      )
        return record.level;
    } catch {
      /* Plain console or pretty logger line. */
    }
    return undefined;
  };
  for (const level of LEVELS) {
    wrappers[level] = (...args: unknown[]) => {
      if (stopped || recordLevel(format(...args)) === 'error') {
        originals[level](...args);
      } else {
        remember({ kind: 'console', level, args });
      }
    };
    if (enabled) console[level] = wrappers[level];
  }
  const write = function (
    this: NodeJS.WriteStream,
    ...args: Parameters<typeof process.stderr.write>
  ): boolean {
    const text = typeof args[0] === 'string' ? args[0] : Buffer.from(args[0]).toString();
    const plain = stripVTControlCharacters(text).trim();
    const lines = plain.split(/\r?\n/);
    const diagnostic = lines.every((line) => {
      const level = recordLevel(line);
      return (
        (level !== undefined && ['warn', 'info', 'debug', 'trace'].includes(level)) ||
        /^\d{2}:\d{2}:\d{2}\s+(WARN|INFO|DEBUG|TRACE)\s/.test(line)
      );
    });
    if (stopped || !diagnostic) return originalWrite.apply(this, args);
    // The DefaultLogger already persisted these records; do not log them twice.
    remember({ kind: 'stderr', text });
    const callback = typeof args[1] === 'function' ? args[1] : args[2];
    if (typeof callback === 'function') callback();
    return true;
  } as typeof process.stderr.write;
  const emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
    if (stopped) originalWarning.apply(process, args);
    else remember({ kind: 'warning', args });
  }) as typeof process.emitWarning;
  if (enabled) {
    process.stderr.write = write;
    process.emitWarning = emitWarning;
  }
  return {
    acceptTui(fileLogger: Logger): void {
      if (stopped) return;
      quiet = true;
      logger = fileLogger;
      for (const output of buffered.splice(0)) remember(output);
    },
    stop(replay = !quiet): void {
      if (stopped) return;
      stopped = true;
      for (const level of LEVELS) {
        if (console[level] === wrappers[level]) console[level] = originals[level];
      }
      if (process.stderr.write === write) process.stderr.write = originalWrite;
      if (process.emitWarning === emitWarning) process.emitWarning = originalWarning;
      if (replay) {
        for (const output of buffered) {
          if (output.kind === 'console') originals[output.level](...output.args);
          else if (output.kind === 'stderr') originalWrite.call(process.stderr, output.text);
          else originalWarning.apply(process, output.args);
        }
      }
      buffered.length = 0;
    },
  };
}
