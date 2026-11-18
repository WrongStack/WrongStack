import type { EventEmitter } from 'node:events';
import { expectDefined, writeErr } from '@wrongstack/core/utils';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { scheduleHandshakeTimeout } from '../handshake-timeout.js';
import type { ACPMessage } from '../types/acp-messages.js';
import { buildWin32CmdShimInvocation } from '../win32-cmd.js';

export const DEFAULT_MAX_FRAME_CHARS = 20 * 1024 * 1024;

export const DEFAULT_MAX_QUEUED_MESSAGES = 1_000;

export const DEFAULT_MAX_QUEUED_CHARS = 32 * 1024 * 1024;

/** Characters of a child's stderr kept to explain a crash. */
const STDERR_TAIL_CHARS = 4096;

/**
 * Whether to echo an ACP child's stderr live. External agents log routine
 * diagnostics there (Claude's adapter prints every SDK message it does not
 * map), and the host is often a TUI or a web server where those lines are
 * noise. Off by default; the tail is still shown when the child crashes.
 */
function echoChildStderr(): boolean {
  const v = process.env.WRONGSTACK_DEBUG;
  return !!v && v !== '0' && v !== 'false';
}

/** The last non-empty line of `text`, bounded for a one-line reason. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.length > 300 ? `${line.slice(0, 300)}…` : line;
  }
  return '';
}

export interface QueuedMessage {
  message: ACPMessage;
  chars: number;
}

/**
 * Append `chunk` to the pending tail and return the complete lines it closes.
 * Only the new chunk is searched for newlines: `(pending + chunk).split('\n')`
 * re-scanned the whole unterminated frame on every stdin chunk — O(n²) while a
 * multi-MiB frame (a session/load, a file read reply) was still arriving.
 */
export function takeLines(pending: string, chunk: string): { lines: string[]; pending: string } {
  const lines: string[] = [];
  let start = 0;
  for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
    lines.push(pending + chunk.slice(start, nl));
    pending = '';
    start = nl + 1;
  }
  return { lines, pending: pending + chunk.slice(start) };
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Minimal client-side transport contract `ACPSession` drives. `ClientTransport`
 * (stdio subprocess) and `WebSocketClientTransport` (remote) both implement it,
 * so the session is agnostic to how bytes reach the agent.
 */
export interface ACPClientTransport {
  start(): Promise<void>;
  send(msg: ACPMessage): Promise<void>;
  /**
   * See {@link AgentServerTransport.onMessage}. The client contract has the
   * same dual-fire guarantee: handlers fire for every inbound message,
   * regardless of any concurrent reader. Client-side consumers always
   * observe the full message stream via onMessage, so claim semantics
   * are not needed — see {@link onMessageClaim} for the optional
   * claim variant.
   */
  onMessage(handler: (msg: ACPMessage) => void): () => void;
  /**
   * See {@link AgentServerTransport.onMessageClaim}. Optional on the
   * client contract: client-side consumers always observe the full
   * message stream via onMessage, so claim semantics are not needed.
   */
  onMessageClaim?(handler: (msg: ACPMessage) => boolean): () => void;
  /**
   * Called once when the connection ends for any reason (the agent exited,
   * the socket closed, a frame limit tripped, stop()). Optional for custom
   * transports; without it a client learns of a dead agent only when each
   * in-flight request times out.
   */
  onClose?(handler: (reason: string) => void): () => void;
  stop(): void;
}

export interface ClientTransportOptions {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string>;
  cwd?: string | undefined;
  handshakeTimeoutMs?: number | undefined;
  /**
   * Set to true when the child is an external ACP agent (Claude Code,
   * Gemini CLI, Codex CLI, …) that does NOT emit a `[wstack-acp]\n`
   * marker on startup. The v1 client (`ACPSession`) sets this; the
   * server-side transport (the default) keeps the marker check.
   */
  skipHandshakeMarker?: boolean | undefined;
  /** Maximum pending newline-delimited JSON frame size. Default 20 MiB. */
  maxFrameChars?: number | undefined;
  /** Maximum messages retained for the optional read() API. Default 1000. */
  maxQueuedMessages?: number | undefined;
  /** Maximum serialized characters retained for the optional read() API. Default 32 MiB. */
  maxQueuedChars?: number | undefined;
}

export interface ACPChildProcess extends EventEmitter {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  stderr: NodeJS.ReadableStream;
  pid: number | undefined;
  kill(): void;
}

export class ClientTransport implements ACPClientTransport {
  private child: ACPChildProcess | null = null;
  private starting: Promise<void> | undefined;
  private readonly startupAbort = new AbortController();
  private buffer = '';
  private stderrTail = '';
  private stopRequested = false;
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private readonly claimHandlers = new Set<(msg: ACPMessage) => boolean>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private closed = false;
  private readonly pendingReads: Array<(msg: ACPMessage | null) => void> = [];
  private messageQueue: QueuedMessage[] = [];
  private queuedChars = 0;
  private readonly opts: ClientTransportOptions & { handshakeTimeoutMs: number };
  private readonly maxFrameChars: number;
  private readonly maxQueuedMessages: number;
  private readonly maxQueuedChars: number;

  constructor(options: ClientTransportOptions) {
    this.opts = {
      ...options,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 30_000,
    };
    this.maxFrameChars = positiveLimit(options.maxFrameChars, DEFAULT_MAX_FRAME_CHARS);
    this.maxQueuedMessages = positiveLimit(options.maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES);
    this.maxQueuedChars = positiveLimit(options.maxQueuedChars, DEFAULT_MAX_QUEUED_CHARS);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('ClientTransport is closed');
    if (this.starting) return this.starting;
    if (this.child) return;
    const starting = this.startChild();
    this.starting = starting;
    try {
      await starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startChild(): Promise<void> {
    const [{ spawn }, { buildChildEnv }, os] = await Promise.all([
      import('node:child_process'),
      import('@wrongstack/core/utils'),
      import('node:os'),
    ]);
    if (this.closed) throw new Error('ClientTransport is closed');
    return new Promise((resolve, reject) => {
      const signal = this.startupAbort.signal;
      let settled = false;
      let detachReady: (() => void) | undefined;
      const finishStartup = (): boolean => {
        if (settled) return false;
        settled = true;
        cancelTimeout();
        signal.removeEventListener('abort', onAbort);
        detachReady?.();
        return true;
      };
      const onAbort = () => {
        if (finishStartup()) reject(signal.reason);
      };
      const cancelTimeout = scheduleHandshakeTimeout(this.opts.handshakeTimeoutMs, () => {
        if (!finishStartup()) return;
        // Reject the start promise, but first tear down the child we just
        // spawned — otherwise a slow-spawning npx/uvx leaves a real process
        // holding pipes open, with the handshake timer the only handle
        // (RAM-leak audit 2026-07-31, LOW).
        const child = this.child;
        this.child = null;
        this.buffer = '';
        this.stderrTail = '';
        /* v8 ignore start - defensive child cleanup on startup timeout */
        if (child) {
          try {
            treeKill(child);
          } catch {
            // best effort — child may have already exited
          }
        }
        /* v8 ignore stop */
        reject(
          new Error(`ACP child process failed to start within ${this.opts.handshakeTimeoutMs}ms`),
        );
      });
      signal.addEventListener('abort', onAbort, { once: true });

      // `npx`/`uvx` resolve+install the package using the npm/pip config of
      // the spawn cwd. Inside a repo with dependency `overrides` (WrongStack
      // pins undici/jsdom), that install fails with EOVERRIDE and the adapter
      // never starts → handshake timeout. Spawn package launchers from a
      // NEUTRAL dir (home) so they install cleanly; the agent still learns the
      // project directory via the ACP `session/new` `cwd` param, not this cwd.
      const isPkgLauncher = this.opts.command === 'npx' || this.opts.command === 'uvx';
      const spawnCwd = isPkgLauncher ? os.homedir() : this.opts.cwd;

      try {
        const childArgs = this.opts.args ?? [];
        const invocation = spawnInvocation(this.opts.command, childArgs, process.platform);
        this.child = spawn(invocation.command, invocation.args, {
          env: { ...buildChildEnv(), ...this.opts.env },
          cwd: spawnCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...verbatimOptions(invocation),
        }) as never as ACPChildProcess;
        /* v8 ignore start -- spawn() throwing synchronously is a defensive guard (e.g. argv0 type errors); the realistic async failure path is the child 'error' event, covered by tests. */
      } catch (err) {
        finishStartup();
        reject(err);
        return;
      }
      /* v8 ignore stop */

      const child = this.child;

      child.stdout.setEncoding('utf8');

      // Register failure handlers IMMEDIATELY, before either readiness path,
      // so a spawn failure (ENOENT / EACCES) rejects start() instead of
      // emitting an unhandled 'error' event that crashes the host process.
      // This is critical for the skip-marker path (external ACP agents),
      // which previously returned before any 'error' listener was attached.
      const onSpawnFailure = (err: Error): void => {
        if (this.closed || this.child !== child) return;
        if (!finishStartup()) {
          this.stop(`agent transport error: ${err.message}`);
          return;
        }
        reject(err);
      };
      child.on('error', onSpawnFailure);
      child.stdout.on('error', onSpawnFailure);
      child.stderr.on('data', (chunk: string) => {
        if (this.child === child) this.onChildError(chunk);
      });
      child.once('close', (code: number | null, exitSignal?: NodeJS.Signals | null) => {
        if (this.child !== child) return;
        const wasStarting = finishStartup();
        const reason = this.onChildClose(code, exitSignal);
        if (wasStarting) reject(new Error(reason));
      });

      if (this.opts.skipHandshakeMarker) {
        // External ACP agents don't emit a startup marker. Attach the data
        // pump right away so no early output is dropped, then resolve once
        // the OS confirms the process actually spawned (the 'spawn' event).
        // If the binary is missing, 'error' fires instead and rejects above.
        child.stdout.on('data', (c: string) => this.onChildData(child, c));
        const onSpawn = () => {
          if (finishStartup()) resolve();
        };
        detachReady = () => child.off('spawn', onSpawn);
        child.once('spawn', onSpawn);
        return;
      }

      const onReady = (): boolean => {
        if (!finishStartup()) return false;
        child.stdout.on('data', (c: string) => this.onChildData(child, c));
        resolve();
        return true;
      };

      const waitForMarker = (chunk: string) => {
        this.buffer += chunk;
        // The framed paths (onData / onChildData) both enforce maxFrameChars;
        // this handshake path did not, so a child that never emits the marker
        // grew the buffer without limit until the connect timeout fired.
        // Keeping the tail is safe: the marker can only be found near the end.
        if (this.buffer.length > this.maxFrameChars) {
          this.buffer = this.buffer.slice(-this.maxFrameChars);
        }
        const idx = this.buffer.indexOf('[wstack-acp]\n');
        if (idx !== -1) {
          const rest = this.buffer.slice(idx + '[wstack-acp]\n'.length);
          this.buffer = '';
          // Frames that shared the marker's chunk go through the same framing
          // as later chunks. Left raw in `buffer`, a complete line broke
          // takeLines' newline-free pending tail: it was never delivered, and
          // the next chunk merged into it and failed to parse with it.
          if (onReady() && rest) this.onChildData(child, rest);
        }
      };

      detachReady = () => child.stdout.off('data', waitForMarker);
      child.stdout.on('data', waitForMarker);
    });
  }

  send(msg: ACPMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ClientTransport is closed'));
    if (!this.child) return Promise.reject(new Error('ClientTransport not started'));
    return new Promise((resolve, reject) => {
      const line = JSON.stringify(msg) + '\n';
      this.child?.stdin.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  read(): Promise<ACPMessage | null> {
    if (this.messageQueue.length > 0) {
      const queued = expectDefined(this.messageQueue.shift());
      this.queuedChars = Math.max(0, this.queuedChars - queued.chars);
      return Promise.resolve(queued.message);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingReads.push(resolve);
    });
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Register a handler that MAY claim a message by returning `true`.
   * Claimed messages are NOT enqueued for the read() loop — they are
   * considered fully consumed by the handler. This is how the ACP
   * server transport prevents the correlation handler (which always
   * fires on every message but only actually correlates responses)
   * from starving the read() loop of pipelined requests, notifications,
   * and any message the handler chose to ignore. See dispatch() for
   * the gating logic.
   */
  onMessageClaim(handler: (msg: ACPMessage) => boolean): () => void {
    this.claimHandlers.add(handler);
    return () => this.claimHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Tell close listeners once; the handlers are dropped with the connection. */
  private notifyClosed(reason: string): void {
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        // a faulty listener must not stop the teardown
      }
    }
  }

  stop(reason = 'transport stopped'): void {
    this.closed = true;
    this.stopRequested = true;
    this.startupAbort.abort(new Error(reason));
    for (const resolve of this.pendingReads.splice(0)) resolve(null);
    this.buffer = '';
    this.stderrTail = '';
    this.messageQueue.length = 0;
    this.queuedChars = 0;
    this.handlers.clear();
    this.claimHandlers.clear();
    this.notifyClosed(reason);
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.end?.();
    } catch {
      // best-effort EOF before treeKill
    }
    // On Windows `child` is the cmd.exe shim wrapper; a bare kill() orphans the
    // real agent grandchild. treeKill tears down the whole process tree.
    treeKill(child);
    this.child = null;
  }

  private onChildData(child: ACPChildProcess, chunk: string): void {
    if (this.closed || this.child !== child) return;
    const { lines, pending } = takeLines(this.buffer, chunk);
    this.buffer = pending;
    if (this.buffer.length > this.maxFrameChars) {
      writeErr(`[acp-child pending frame exceeds ${this.maxFrameChars} characters]\n`);
      this.stop(`agent frame exceeds ${this.maxFrameChars} characters`);
      return;
    }

    for (const raw of lines) {
      if (this.closed) return;
      if (!raw.trim()) continue;
      if (raw.length > this.maxFrameChars) {
        writeErr(`[acp-child frame exceeds ${this.maxFrameChars} characters]\n`);
        this.stop(`agent frame exceeds ${this.maxFrameChars} characters`);
        return;
      }
      try {
        this.dispatch(JSON.parse(raw) as ACPMessage, raw.length);
      } catch {
        // skip malformed
      }
    }
  }

  private onChildError(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    if (echoChildStderr()) writeErr(`[acp-child stderr] ${chunk}`);
  }

  private onChildClose(code: number | null, signal?: NodeJS.Signals | null): string {
    this.closed = true;
    this.child = null;
    for (const resolve of this.pendingReads.splice(0)) resolve(null);
    this.buffer = '';
    this.messageQueue.length = 0;
    this.queuedChars = 0;
    this.handlers.clear();
    this.claimHandlers.clear();
    // Killing the tree on stop() ends the child with a non-zero code (1 on
    // Windows): that is our teardown, not a crash to report.
    const failed = !this.stopRequested && (signal != null || (code !== 0 && code !== null));
    const exit = signal ? `terminated by signal ${signal}` : `exited with code ${code}`;
    if (failed) {
      // The live echo is off by default, so a crash shows what led up to it.
      const tail = echoChildStderr() ? '' : this.stderrTail.trimEnd();
      writeErr(`[acp-child ${exit}]\n${tail ? `${tail}\n` : ''}`);
    }
    const cause = failed ? lastLine(this.stderrTail) : '';
    this.stderrTail = '';
    const reason = `agent process ${exit}${cause ? `: ${cause}` : ''}`;
    this.notifyClosed(reason);
    return reason;
  }

  private dispatch(msg: ACPMessage, chars = JSON.stringify(msg).length): void {
    const resolve = this.pendingReads.shift();
    if (resolve) {
      resolve(msg);
    } else {
      let claimed = false;
      for (const handler of this.claimHandlers) {
        try {
          if (handler(msg)) claimed = true;
        } catch (err) {
          writeErr(`[acp-child handler error] ${err}\n`);
        }
      }
      if (this.closed) return;
      if (!claimed && this.handlers.size === 0) {
        if (
          this.messageQueue.length >= this.maxQueuedMessages ||
          this.queuedChars + chars > this.maxQueuedChars
        ) {
          writeErr(
            `[acp-child message queue exceeds ${this.maxQueuedMessages} entries or ${this.maxQueuedChars} characters]\n`,
          );
          this.stop();
          return;
        }
        this.messageQueue.push({ message: msg, chars });
        this.queuedChars += chars;
      }
    }
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch {
        // non-fatal
      }
    }
  }
}

export function spawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: true;
} {
  if (platform !== 'win32') return { command, args };
  return buildWin32CmdShimInvocation(command, args);
}

export function verbatimOptions(invocation: { windowsVerbatimArguments?: true }): {
  windowsVerbatimArguments?: true;
} {
  return invocation.windowsVerbatimArguments
    ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
    : {};
}
