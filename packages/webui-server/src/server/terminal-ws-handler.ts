import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Logger } from '@wrongstack/contracts/types';
import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { buildChildEnv, isStandaloneBinary, toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { repairNodePtySpawnHelper, spawnHelperFailureHint } from './node-pty-spawn-helper.js';
import { authorizeWebUIAction } from './privileged-actions.js';
import type { WSServerMessage } from './types.js';
import { sendSerialized } from './ws-utils.js';

/** Loose inbound shape — matches the server's internal WSClientMessage. */
type IncomingMessage = { type: string; payload?: unknown };
type PtyExit = { exitCode: number; signal?: number | undefined };
interface PtyProcess {
  readonly pid?: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (event: PtyExit) => void): unknown;
}
interface NodePtyApi {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string | undefined>;
      useConptyDll?: boolean | undefined;
    },
  ): PtyProcess;
}
type LoadNodePty = () => NodePtyApi | null;
type KillProcessTree = (pid: number) => void;

interface TerminalCreate {
  id: string;
  cols?: number | undefined;
  rows?: number | undefined;
  resumeKey?: string | undefined;
  resumeOnly?: boolean | undefined;
  after?: number | undefined;
}

interface TerminalSession {
  id: string;
  pty: PtyProcess;
  owner: WebSocket | null;
  resumeKey?: string | undefined;
  sequence: number;
  frames: Array<{ sequence: number; data: string }>;
  bufferedChars: number;
  expires?: ReturnType<typeof setTimeout> | undefined;
  exit?: PtyExit | undefined;
}

/** Hard cap on concurrent PTYs per connected client — a runaway-spawn backstop. */
const MAX_SESSIONS_PER_CLIENT = 8;
const MAX_DETACHED_SESSIONS = 32;
const RESUME_WINDOW_MS = 60_000;
const MAX_REPLAY_CHARS = 256 * 1024;
const MAX_REPLAY_FRAMES = 1_024;
/** Bound each native PTY write. The WebSocket server bounds the incoming frame. */
const PTY_WRITE_CHUNK = 1 << 16;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const requireFromHere = createRequire(import.meta.url);
let cachedNodePty: NodePtyApi | null | undefined;

export function resolveTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return platform === 'win32' ? env.COMSPEC || 'cmd.exe' : env.SHELL || '/bin/sh';
}

/**
 * TerminalWebSocketHandler — backs the WebUI's integrated terminal panel.
 *
 * Mirrors the lifecycle shape of WorktreeWebSocketHandler but is *per-client*
 * and *interactive*: each connected WebSocket owns a map of real node-pty
 * sessions keyed by a client-chosen id. Browser xterm.js ⇄ pty wiring:
 *   - `terminal.create` → spawn a shell pty, stream its output back
 *   - `terminal.input`  → write keystrokes to the pty
 *   - `terminal.resize` → propagate xterm's fit dimensions
 *   - `terminal.close`  → kill the pty
 * A client can opt into bounded reconnect replay with a private, per-tab key.
 */
function isSocketDisconnected(ws: WebSocket): boolean {
  return ws.readyState === 2 || ws.readyState === 3;
}

export class TerminalWebSocketHandler {
  /** ws → (terminalId → pty). */
  private readonly sessions = new Map<WebSocket, Map<string, TerminalSession>>();
  private readonly resumable = new Map<string, TerminalSession>();
  private readonly detached = new Set<TerminalSession>();
  /**
   * ws → (terminalId → token of the create still awaiting authorization).
   * The dispatcher does not await handleMessage, so a create/close/create burst
   * (reconnect replay, StrictMode remount) interleaves across that await.
   */
  private readonly starting = new Map<WebSocket, Map<string, symbol>>();
  private readonly socketOffs = new Map<WebSocket, () => void>();
  private disposed = false;

  constructor(
    /** Resolves the cwd new terminals open in — tracks the live working dir. */
    private readonly getCwd: () => string,
    private readonly logger: Logger,
    private readonly loadNodePty: LoadNodePty = defaultLoadNodePty,
    private readonly killProcessTree: KillProcessTree = defaultKillProcessTree,
    private readonly trustBoundary: TrustBoundary = createCompatibilityTrustBoundary(),
  ) {}

  addClient(ws: WebSocket): void {
    if (this.disposed || isSocketDisconnected(ws)) return;
    if (!this.sessions.has(ws)) this.sessions.set(ws, new Map());
    if (!this.socketOffs.has(ws)) {
      const onDisconnect = () => this.disposeClient(ws);
      ws.on('close', onDisconnect);
      ws.on('error', onDisconnect);
      this.socketOffs.set(ws, () => {
        ws.off?.('close', onDisconnect);
        ws.off?.('error', onDisconnect);
      });
    }
  }

  /** Kill every pty owned by every client (server shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const ws of [...new Set([...this.sessions.keys(), ...this.socketOffs.keys()])]) {
      this.disposeClient(ws);
    }
    for (const session of this.detached) this.destroy(session, 'terminal host dispose');
  }

  /** True if this message was a terminal.* message (handled here). */
  async handleMessage(ws: WebSocket, msg: IncomingMessage): Promise<boolean> {
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case 'terminal.create':
        if (isStr(p.id))
          await this.create(ws, {
            id: p.id,
            cols: numOrUndef(p.cols),
            rows: numOrUndef(p.rows),
            resumeKey:
              typeof p.resumeKey === 'string' && /^[0-9a-f]{32}$/.test(p.resumeKey)
                ? p.resumeKey
                : undefined,
            resumeOnly: p.resumeOnly === true,
            after:
              typeof p.after === 'number' && Number.isSafeInteger(p.after) && p.after >= 0
                ? p.after
                : 0,
          });
        return true;
      case 'terminal.input':
        if (isStr(p.id) && isStr(p.data)) this.input(ws, { id: p.id, data: p.data });
        return true;
      case 'terminal.resize':
        if (isStr(p.id)) this.resize(ws, { id: p.id, cols: Number(p.cols), rows: Number(p.rows) });
        return true;
      case 'terminal.close':
        if (isStr(p.id)) this.close(ws, p.id);
        return true;
      default:
        return false;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async create(ws: WebSocket, payload: TerminalCreate): Promise<void> {
    const map = this.sessions.get(ws);
    if (this.disposed || !map || isSocketDisconnected(ws)) return;

    let starting = this.starting.get(ws);
    if (!starting) {
      starting = new Map();
      this.starting.set(ws, starting);
    }

    // idempotent — already running or already starting
    if (map.has(payload.id) || starting.has(payload.id)) return;
    if (map.size + starting.size >= MAX_SESSIONS_PER_CLIENT) {
      this.send(ws, {
        type: 'terminal.exit',
        payload: { id: payload.id, exitCode: -1 },
      });
      return;
    }

    const shell = resolveTerminalShell();
    const cwd = this.getCwd();
    const token = Symbol(payload.id);
    starting.set(payload.id, token);
    let cancelled = false;
    let authorization: Awaited<ReturnType<typeof authorizeWebUIAction>>;
    try {
      authorization = await authorizeWebUIAction(
        this.trustBoundary,
        {
          capability: 'process.spawn',
          subject: {
            kind: 'command',
            id: shell,
            attributes: { terminalId: payload.id },
          },
          risk: 'high',
          cwd,
          metadata: { transport: 'websocket' },
        },
        this.logger,
      );
    } finally {
      // A close, or a disconnect, while authorization was pending cancels this
      // create; the create that follows a close holds its own token.
      cancelled =
        this.disposed ||
        isSocketDisconnected(ws) ||
        this.sessions.get(ws) !== map ||
        starting.get(payload.id) !== token ||
        this.starting.get(ws) !== starting;
      if (!cancelled) starting.delete(payload.id);
    }
    if (cancelled) return;
    if (!authorization.allowed) {
      this.logger.warn?.(`terminal.create denied (id=${payload.id}): ${authorization.reason}`);
      const msg = `Integrated terminal denied: ${authorization.reason}`;
      this.send(ws, { type: 'terminal.output', payload: { id: payload.id, data: `${msg}\r\n` } });
      this.send(ws, { type: 'terminal.exit', payload: { id: payload.id, exitCode: -1 } });
      return;
    }

    const prior = payload.resumeKey ? this.resumable.get(payload.resumeKey) : undefined;
    if (prior?.id === payload.id) {
      this.attach(ws, map, prior, payload);
      return;
    }
    if (prior || payload.resumeOnly) {
      this.send(ws, {
        type: 'terminal.exit',
        payload: { id: payload.id, exitCode: -1, disconnected: true },
      });
      return;
    }

    const nodePty = this.loadNodePty();
    if (!nodePty) {
      const msg =
        'Integrated terminal unavailable: optional dependency node-pty is not installed. ' +
        'Install node-pty to enable WebUI terminal sessions.';
      this.logger.warn?.(msg);
      this.send(ws, { type: 'terminal.output', payload: { id: payload.id, data: `${msg}\r\n` } });
      this.send(ws, { type: 'terminal.exit', payload: { id: payload.id, exitCode: -1 } });
      return;
    }

    let pty: PtyProcess;
    try {
      pty = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: clampDim(payload.cols, DEFAULT_COLS),
        rows: clampDim(payload.rows, DEFAULT_ROWS),
        cwd,
        // The painting surface is the browser's xterm.js, regardless of
        // which console (or service manager) launched the WebUI server.
        env: {
          ...buildChildEnv(),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          WRONGSTACK_TUI_TERMINAL: 'browser',
        },
        ...windowsPtyOptions(),
      });
    } catch (err) {
      const hint = spawnHelperFailureHint(toErrorMessage(err));
      const msg = `Integrated terminal failed to start: ${toErrorMessage(err)}${hint ? `\r\n${hint}` : ''}`;
      this.logger.warn?.(`terminal spawn failed: ${toErrorMessage(err)}`);
      this.send(ws, { type: 'terminal.output', payload: { id: payload.id, data: `${msg}\r\n` } });
      this.send(ws, { type: 'terminal.exit', payload: { id: payload.id, exitCode: -1 } });
      return;
    }

    // The client may have disconnected during the `await` on the trust
    // boundary above. `disposeClient` iterates whatever `this.sessions` holds
    // and then DELETES the entry, so writing into `map` now would write into
    // an object no cleanup path can still reach: the shell (and on Windows its
    // conhost/ConPTY tree) would survive `close`, `disposeClient` and the
    // server-wide `dispose()`, leaking one orphan per open/close cycle.
    if (this.disposed || this.sessions.get(ws) !== map || isSocketDisconnected(ws)) {
      this.logger.info?.(
        `terminal.create raced a disconnect (id=${payload.id}) — killing the orphan`,
      );
      this.killPty(pty, 'terminal create after disconnect');
      return;
    }

    const session: TerminalSession = {
      id: payload.id,
      pty,
      owner: ws,
      resumeKey: payload.resumeKey,
      sequence: 0,
      frames: [],
      bufferedChars: 0,
    };
    map.set(payload.id, session);
    if (session.resumeKey) this.resumable.set(session.resumeKey, session);
    this.logger.info?.(
      `terminal.create spawned (id=${payload.id}, pid=${pty.pid ?? '?'}) in ${cwd}`,
    );

    if (session.resumeKey) {
      this.send(ws, { type: 'terminal.ready', payload: { id: payload.id, resumed: false } });
    }
    pty.onData((data) => this.output(session, data));
    pty.onExit(({ exitCode, signal }) => {
      session.exit = { exitCode, signal };
      const owner = session.owner;
      if (!owner || this.sessions.get(owner)?.get(session.id) !== session) return;
      this.sendExit(owner, session);
      this.detachOrDestroy(session);
    });
  }

  private output(session: TerminalSession, data: string): void {
    if (session.exit || (!session.owner && !this.detached.has(session))) return;
    let sequence: number | undefined;
    if (session.resumeKey) {
      sequence = ++session.sequence;
      session.frames.push({ sequence, data });
      session.bufferedChars += data.length;
      while (
        session.bufferedChars > MAX_REPLAY_CHARS ||
        session.frames.length > MAX_REPLAY_FRAMES
      ) {
        session.bufferedChars -= session.frames.shift()?.data.length ?? 0;
      }
    }
    if (session.owner) {
      this.send(session.owner, {
        type: 'terminal.output',
        payload: { id: session.id, data, sequence },
      });
    }
  }

  private attach(
    ws: WebSocket,
    map: Map<string, TerminalSession>,
    session: TerminalSession,
    payload: TerminalCreate,
  ): void {
    this.removeOwner(session);
    clearTimeout(session.expires);
    this.detached.delete(session);
    session.owner = ws;
    map.set(session.id, session);
    const after = Math.min(payload.after ?? 0, session.sequence);
    const first = session.frames[0]?.sequence ?? session.sequence + 1;
    this.send(ws, {
      type: 'terminal.ready',
      payload: { id: session.id, resumed: true, lostOutput: after < first - 1 },
    });
    for (const frame of session.frames) {
      if (frame.sequence > after)
        this.send(ws, { type: 'terminal.output', payload: { id: session.id, ...frame } });
    }
    if (session.exit) {
      this.sendExit(ws, session);
      this.detachOrDestroy(session);
    } else {
      this.resize(ws, {
        id: session.id,
        cols: payload.cols ?? DEFAULT_COLS,
        rows: payload.rows ?? DEFAULT_ROWS,
      });
    }
  }

  private sendExit(ws: WebSocket, session: TerminalSession): void {
    this.send(ws, { type: 'terminal.exit', payload: { id: session.id, ...session.exit } });
  }

  private removeOwner(session: TerminalSession): void {
    if (session.owner) this.sessions.get(session.owner)?.delete(session.id);
    session.owner = null;
  }

  private detachOrDestroy(session: TerminalSession): void {
    if (this.disposed || !session.resumeKey) {
      this.destroy(session, 'terminal client dispose');
      return;
    }
    this.removeOwner(session);
    this.detached.add(session);
    const oldest = this.detached.values().next().value;
    if (oldest && this.detached.size > MAX_DETACHED_SESSIONS)
      this.destroy(oldest, 'terminal reconnect limit');
    session.expires = setTimeout(
      () => this.destroy(session, 'terminal reconnect expired'),
      RESUME_WINDOW_MS,
    );
    session.expires.unref();
  }

  private destroy(session: TerminalSession, reason: string): void {
    this.removeOwner(session);
    clearTimeout(session.expires);
    this.detached.delete(session);
    if (session.resumeKey) this.resumable.delete(session.resumeKey);
    if (!session.exit) this.killPty(session.pty, reason);
  }

  private input(ws: WebSocket, payload: { id: string; data: string }): void {
    const session = this.sessions.get(ws)?.get(payload.id);
    if (!session || session.exit) return;
    const { data } = payload;
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + PTY_WRITE_CHUNK, data.length);
      // node-pty encodes each write independently. Keep a surrogate pair in
      // the same write even when it sits at the chunk boundary.
      const last = data.charCodeAt(end - 1);
      const next = data.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      session.pty.write(data.slice(offset, end));
      offset = end;
    }
  }

  private resize(ws: WebSocket, payload: { id: string; cols: number; rows: number }): void {
    const pty = this.sessions.get(ws)?.get(payload.id)?.pty;
    if (!pty) return;
    try {
      pty.resize(clampDim(payload.cols, DEFAULT_COLS), clampDim(payload.rows, DEFAULT_ROWS));
    } catch {
      /* pty already gone */
    }
  }

  private close(ws: WebSocket, id: string): void {
    this.starting.get(ws)?.delete(id);
    const session = this.sessions.get(ws)?.get(id);
    if (session) this.destroy(session, 'terminal close');
  }

  private disposeClient(ws: WebSocket): void {
    this.socketOffs.get(ws)?.();
    this.socketOffs.delete(ws);
    this.starting.delete(ws);
    const map = this.sessions.get(ws);
    if (!map) return;
    for (const session of map.values()) {
      this.detachOrDestroy(session);
    }
    this.sessions.delete(ws);
  }

  private killPty(pty: PtyProcess, reason: string): void {
    if (process.platform === 'win32' && isPositivePid(pty.pid)) {
      this.killWindowsProcessTree(pty, reason);
      return;
    }
    try {
      pty.kill();
    } catch (err) {
      this.logger.warn?.(`${reason} failed: ${toErrorMessage(err)}`);
    }
  }

  private killWindowsProcessTree(pty: PtyProcess, reason: string): void {
    try {
      this.killProcessTree(pty.pid as number);
      // Give an interactive shell a chance to exit cleanly if taskkill races
      // with ConPTY setup. Avoid node-pty.kill() here: on Windows it forks
      // conpty_console_list_agent, which can emit noisy AttachConsole failures
      // when the WebUI server has no attached console.
      try {
        pty.write('\x03');
        pty.write('exit\r');
      } catch {
        /* process tree kill is already in flight */
      }
    } catch (err) {
      this.logger.warn?.(`${reason} taskkill failed: ${toErrorMessage(err)}`);
    }
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      sendSerialized(ws, JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  }
}

function defaultLoadNodePty(): NodePtyApi | null {
  if (cachedNodePty !== undefined) return cachedNodePty;
  // No native node-pty in the standalone binary: terminal is unavailable there.
  if (isStandaloneBinary()) {
    cachedNodePty = null;
    return null;
  }
  try {
    cachedNodePty = requireFromHere('node-pty') as NodePtyApi;
    repairNodePtySpawnHelper(requireFromHere);
  } catch {
    cachedNodePty = null;
  }
  return cachedNodePty;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function windowsPtyOptions(): { useConptyDll?: boolean | undefined } {
  if (process.platform !== 'win32') return {};
  if (process.env.WRONGSTACK_TERMINAL_USE_CONPTY_DLL !== '1') return {};
  return { useConptyDll: true };
}

function defaultKillProcessTree(pid: number): void {
  const child = spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', () => undefined);
}

function isPositivePid(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

/** Clamp a terminal dimension into a sane range; fall back to a default. */
function clampDim(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}
