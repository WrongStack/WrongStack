export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
  level: LogLevel;
  error(msg: string, ctx?: unknown): void | undefined;
  warn(msg: string, ctx?: unknown): void | undefined;
  info(msg: string, ctx?: unknown): void | undefined;
  debug(msg: string, ctx?: unknown): void | undefined;
  trace(msg: string, ctx?: unknown): void | undefined;
  child(bindings: Record<string, unknown>): Logger;
}
