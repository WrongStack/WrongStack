import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger, LogLevel } from '../types/logger.js';
import { color } from '../utils/color.js';
import { writeErr } from '../utils/term.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const COLORS: Record<LogLevel, (s: string) => string> = {
  error: color.red,
  warn: color.yellow,
  info: color.cyan,
  debug: color.gray,
  trace: color.dim,
};

const LOG_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'debug', 'trace']);
const LOG_FORMATS = new Set<string>(['pretty', 'json']);

export type LogFormat = 'pretty' | 'json';

export interface DefaultLoggerOptions {
  level?: LogLevel | undefined;
  file?: string | undefined;
  /**
   * @deprecated Use `format: 'json'` instead. Kept for backward compat
   * with existing callers but has no effect on output — the `format`
   * option controls whether stderr receives pretty-printed or JSON lines.
   */
  pretty?: boolean | undefined;
  /** Output format for stderr. `pretty` (colored, human-readable) or `json` (machine-parseable). Defaults to `WRONGSTACK_LOG_FORMAT` env var, falling back to `pretty`. */
  format?: LogFormat | undefined;
  bindings?: Record<string, unknown>;
  /**
   * When false, suppress stderr output entirely — only write to the log
   * file (if configured). Use this in TUI mode so plugin/library log
   * messages don't interleave with Ink's terminal rendering.
   * Default: true (stderr output is enabled).
   */
  stderr?: boolean | undefined;
  /**
   * Rotate the log file once it exceeds this many bytes: the current file is
   * renamed to `<file>.1` (replacing any previous one) and a fresh file
   * starts. Bounds total disk to ~2× this value. Default 10 MB.
   */
  maxFileBytes?: number | undefined;
}

export class DefaultLogger implements Logger {
  /** How many file writes between rotation size checks (statSync is not free). */
  private static readonly ROTATE_CHECK_EVERY = 100;
  private static readonly MAX_PENDING_FILE_WRITES = 2_000;
  private static readonly MAX_PENDING_FILE_BYTES = 8 * 1024 * 1024;

  level: LogLevel;
  private file?: string | undefined;
  private bindings: Record<string, unknown>;
  private format: LogFormat;
  private stderr: boolean;
  private maxFileBytes: number;
  private writesSinceRotateCheck = 0;
  /**
   * Serialized async tail for file writes. Every appendFile (and any
   * chained rotation) is awaited through this promise so file I/O
   * never overlaps itself — preserving the per-line ordering the
   * sync version had, but without blocking the caller thread. Any
   * rejection is swallowed (`catch(() => {})`) because logging must
   * never crash the host.
   *
   * Children share the parent's tail: `child.tail === parent.tail`
   * for the lifetime of the chain. Read/write access goes through
   * `_tail` so that, when a child has been wired to a parent, both
   * `enqueueRotate` and `log` always observe the parent's current tail
   * rather than a stale snapshot taken at `child()` time.
   */
  private tail: Promise<void> = Promise.resolve();
  private parent: DefaultLogger | null = null;
  private pendingFileWrites = 0;
  private pendingFileBytes = 0;

  private get root(): DefaultLogger {
    return this.parent ? this.parent.root : this;
  }

  /**
   * Resolve the current tail. For the root logger this is the field;
   * for a child logger we always read through the parent so that a
   * child's appends land on the parent's most recent tail, and a
   * parent's `flush()` waits for everything the child chained.
   */
  private get _tail(): Promise<void> {
    return this.parent ? this.parent._tail : this.tail;
  }
  private set _tail(next: Promise<void>) {
    if (this.parent) this.parent.tail = next;
    else this.tail = next;
  }

  constructor(opts: DefaultLoggerOptions = {}) {
    this.level = opts.level ?? parseLogLevel(process.env.WRONGSTACK_LOG_LEVEL);
    this.file = opts.file;
    this.bindings = opts.bindings ?? {};
    this.format = opts.format ?? parseLogFormat(process.env.WRONGSTACK_LOG_FORMAT);
    this.stderr = opts.stderr !== false; // default true
    this.maxFileBytes = opts.maxFileBytes ?? 10 * 1024 * 1024;
    if (this.file) {
      // Chain mkdir onto the file-write tail so the first append can't
      // race a still-pending mkdir (especially under tests that call
      // `flush()` immediately after `info()`). mkdir is best-effort;
      // a rejection only blocks subsequent appends in the chain that
      // observed it via the rejected promise, which would skip the
      // append — that is acceptable because ENOENT/EEXIST/EPERM all
      // either are no-ops or indicate an unrecoverable environment.
      const dir = path.dirname(this.file);
      this._tail = this._tail
        .then(async () => {
          await fsp.mkdir(dir, { recursive: true });
        })
        .catch(() => undefined);
    }
  }

  error(msg: string, ctx?: unknown): void {
    this.log('error', msg, ctx);
  }
  warn(msg: string, ctx?: unknown): void {
    this.log('warn', msg, ctx);
  }
  info(msg: string, ctx?: unknown): void {
    this.log('info', msg, ctx);
  }
  debug(msg: string, ctx?: unknown): void {
    this.log('debug', msg, ctx);
  }
  trace(msg: string, ctx?: unknown): void {
    this.log('trace', msg, ctx);
  }

  child(bindings: Record<string, unknown>): Logger {
    // Construct without invoking the class constructor (which would mkdir
    // again and create a separate file-write tail). The parent and child
    // must share the same tail so `parent.flush()` waits for child
    // appends too — otherwise a test that flushes the parent after
    // `child.info(...)` would race the child append and observe an empty
    // file. Sharing the tail preserves the order the parent originally
    // had via its serialised file-write queue.
    const child = Object.create(DefaultLogger.prototype) as DefaultLogger;
    child.level = this.level;
    child.file = this.file;
    child.bindings = { ...this.bindings, ...bindings };
    child.format = this.format;
    child.stderr = this.stderr;
    child.maxFileBytes = this.maxFileBytes;
    child.parent = this;
    child.writesSinceRotateCheck = this.writesSinceRotateCheck;
    return child;
  }

  /**
   * Wait until all queued file writes (and any pending rotation) have
   * completed. `log()` is fire-and-forget by design — the caller never
   * blocks on disk — so tests, shutdown handlers, and processes that
   * need a deterministic "everything is on disk now" guarantee should
   * `await logger.flush()` before reading the file or exiting.
   */
  flush(): Promise<void> {
    return this._tail;
  }

  /**
   * Size-based rotation: when the file outgrows `maxFileBytes`, rename it to
   * `<file>.1` (dropping the previous `.1`) so the live file restarts empty.
   * Checked on the first write and every ROTATE_CHECK_EVERY writes after.
   * Best-effort: a rename can fail on Windows while another process holds
   * the file — the next check retries. Multiple processes appending to the
   * same log all run this check; whoever crosses the threshold first wins.
   *
   * Async: the rotation runs on the file-write tail (so its writes don't
   * interleave with the next append), and the caller never blocks on a
   * statSync / renameSync syscall on the hot log path.
   */
  private enqueueRotate(file: string): void {
    if (this.writesSinceRotateCheck++ % DefaultLogger.ROTATE_CHECK_EVERY !== 0) return;
    this._tail = this._tail
      .then(async () => {
        let st;
        try {
          st = await fsp.stat(file);
        } catch {
          return; // file missing — nothing to rotate
        }
        if (st.size < this.maxFileBytes) return;
        try {
          await fsp.rm(`${file}.1`, { force: true });
          await fsp.rename(file, `${file}.1`);
        } catch {
          // file locked, or raced by another process — ignore
        }
      })
      .catch(() => undefined);
  }

  private log(level: LogLevel, msg: string, ctx?: unknown): void {
    const r = LEVEL_RANK[level];
    const allowed = LEVEL_RANK[this.level];
    if (r > allowed) return;
    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = { ts, level, msg, ...this.bindings };
    if (ctx !== undefined) {
      entry.ctx = ctx instanceof Error ? { message: ctx.message, stack: ctx.stack } : ctx;
    }
    // Disk: JSON line. Serialized through `_tail` so concurrent log
    // calls preserve per-line order without blocking the caller on
    // sync file I/O. Children route through their parent's tail, so
    // a parent's `flush()` waits for every chained child append.
    if (this.file) {
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      const root = this.root;
      if (
        root.pendingFileWrites < DefaultLogger.MAX_PENDING_FILE_WRITES &&
        bytes <= DefaultLogger.MAX_PENDING_FILE_BYTES &&
        root.pendingFileBytes + bytes <= DefaultLogger.MAX_PENDING_FILE_BYTES
      ) {
        root.pendingFileWrites += 1;
        root.pendingFileBytes += bytes;
        this.enqueueRotate(this.file);
        this._tail = this._tail
          .then(() => fsp.appendFile(this.file!, line, { mode: 0o600 }))
          .catch(() => undefined)
          .finally(() => {
            root.pendingFileWrites = Math.max(0, root.pendingFileWrites - 1);
            root.pendingFileBytes = Math.max(0, root.pendingFileBytes - bytes);
          });
      }
    }
    // Stderr: pretty or json. Suppressed when this.stderr is false (TUI mode)
    // so plugin/library log messages don't interleave with Ink's rendering.
    if (!this.stderr) return;
    if (this.format === 'json') {
      writeErr(`${JSON.stringify(entry)}\n`);
    } else {
      const head = `${color.dim(ts)} ${COLORS[level](level.toUpperCase().padEnd(5))} ${msg}`;
      if (ctx !== undefined) {
        writeErr(`${head} ${formatCtx(ctx)}\n`);
      } else {
        writeErr(`${head}\n`);
      }
    }
  }
}

function parseLogLevel(raw: string | undefined): LogLevel {
  return raw && LOG_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

function parseLogFormat(raw: string | undefined): LogFormat {
  return raw && LOG_FORMATS.has(raw) ? (raw as LogFormat) : 'pretty';
}

function formatCtx(ctx: unknown): string {
  if (ctx instanceof Error) return color.dim(ctx.message);
  if (typeof ctx === 'string') return color.dim(ctx);
  try {
    return color.dim(JSON.stringify(ctx));
  } catch {
    return color.dim(String(ctx));
  }
}

/**
 * A logger that silently discards all messages. Used during boot before
 * the real logger is configured, and in test contexts where logging
 * would be noise.
 */
export const noOpLogger: Logger = {
  // 'error' is the quietest level the Logger contract offers; the methods
  // discard everything regardless, this only matters to level checks.
  level: 'error',
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => noOpLogger,
};
