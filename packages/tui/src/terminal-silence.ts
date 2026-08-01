// Ink owns the terminal while the TUI is running. Any write to stdout or
// stderr that doesn't go through Ink's render cycle will interleave with
// ANSI control sequences, causing visible content to jump from the bottom
// and corrupt the chat-history / input-area layout.
//
// All silenced output is lost during TUI mode. The DefaultLogger still writes
// structured logs to the log file for post-hoc debugging.
const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
const origConsoleDebug = console.debug;
const origConsoleInfo = console.info;
const origConsoleTable = console.table;
const origConsoleTrace = console.trace;
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);

const consoleNoop = (..._args: unknown[]): void => {};
const stderrNoop = ((
  _chunk: string | Uint8Array,
  _encodingOrCb?: BufferEncoding | ((err?: Error) => void),
  _cb?: (err?: Error) => void,
): boolean => {
  // Preserve Node's callback contract so callers that pass a cb don't hang.
  if (typeof _encodingOrCb === 'function') _encodingOrCb();
  else if (typeof _cb === 'function') _cb();
  return true;
}) as typeof process.stderr.write;
const warningNoop = (_warning: Error): void => {};

export function silenceTerminal(): void {
  console.log = consoleNoop;
  console.warn = consoleNoop;
  console.error = consoleNoop;
  console.debug = consoleNoop;
  console.info = consoleNoop;
  console.table = consoleNoop;
  console.trace = consoleNoop;
  process.stderr.write = stderrNoop as typeof process.stderr.write;
  process.on('warning', warningNoop);
}

export function unsilenceTerminal(): void {
  console.log = origConsoleLog;
  console.warn = origConsoleWarn;
  console.error = origConsoleError;
  console.debug = origConsoleDebug;
  console.info = origConsoleInfo;
  console.table = origConsoleTable;
  console.trace = origConsoleTrace;
  process.stderr.write = origStderrWrite;
  // Restore stdout.write to the module-load original. silenceTerminal does
  // NOT silence stdout (Ink needs it for rendering), but other code —
  // Ink's internal patches, title controllers, or term.ts escape sequences —
  // may wrap or replace process.stdout.write during the TUI session.
  // Restoring here ensures the TUI exit is transactional: callers see the
  // same stdout.write they had before the TUI started.
  process.stdout.write = origStdoutWrite;
  process.off('warning', warningNoop);
}
