import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Logger } from '@wrongstack/core/types';
import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { buildChildEnv, toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
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

/** Hard cap on concurrent PTYs per connected client — a runaway-spawn backstop. */
const MAX_SESSIONS_PER_CLIENT = 8;
/** Maximum characters accepted in a single terminal.input — a DoS backstop. */
const MAX_INPUT_BYTES = 1 << 16; // 64 KiB
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
 * When a client disconnects, every pty it owns is killed (no orphan shells).
 */
export class TerminalWebSocketHandler {
  /** ws → (terminalId → pty). */
  private readonly sessions = new Map<WebSocket, Map<string, PtyProcess>>();

  constructor(
    /** Resolves the cwd new terminals open in — tracks the live working dir. */
    private readonly getCwd: () => string,
    private readonly logger: Logger,
    private readonly loadNodePty: LoadNodePty = defaultLoadNodePty,
    private readonly killProcessTree: KillProcessTree = defaultKillProcessTree,
    private readonly trustBoundary: TrustBoundary = createCompatibilityTrustBoundary(),
  ) {}

  addClient(ws: WebSocket): void {
    if (!this.sessions.has(ws)) this.sessions.set(ws, new Map());
    ws.on('close', () => this.disposeClient(ws));
    ws.on('error', () => this.disposeClient(ws));
  }

  /** Kill every pty owned by every client (server shutdown). */
  dispose(): void {
    for (const ws of [...this.sessions.keys()]) this.disposeClient(ws);
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

  private async create(
    ws: WebSocket,
    payload: { id: string; cols?: number | undefined; rows?: number | undefined },
  ): Promise<void> {
    const map = this.sessions.get(ws) ?? new Map<string, PtyProcess>();
    this.sessions.set(ws, map);

    if (map.has(payload.id)) return; // idempotent — already running
    if (map.size >= MAX_SESSIONS_PER_CLIENT) {
      this.send(ws, {
        type: 'terminal.exit',
        payload: { id: payload.id, exitCode: -1 },
      });
      return;
    }

    const shell = resolveTerminalShell();
    const cwd = this.getCwd();
    const authorization = await authorizeWebUIAction(
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
    if (!authorization.allowed) {
      this.logger.warn?.(`terminal.create denied (id=${payload.id}): ${authorization.reason}`);
      const msg = `Integrated terminal denied: ${authorization.reason}`;
      this.send(ws, { type: 'terminal.output', payload: { id: payload.id, data: `${msg}\r\n` } });
      this.send(ws, { type: 'terminal.exit', payload: { id: payload.id, exitCode: -1 } });
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
        name: 'xterm-color',
        cols: clampDim(payload.cols, DEFAULT_COLS),
        rows: clampDim(payload.rows, DEFAULT_ROWS),
        cwd,
        env: buildChildEnv(),
        ...windowsPtyOptions(),
      });
    } catch (err) {
      const msg = `Integrated terminal failed to start: ${toErrorMessage(err)}`;
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
    if (this.sessions.get(ws) !== map) {
      this.logger.info?.(
        `terminal.create raced a disconnect (id=${payload.id}) — killing the orphan`,
      );
      this.killPty(pty, 'terminal create after disconnect');
      return;
    }

    map.set(payload.id, pty);
    this.logger.info?.(
      `terminal.create spawned (id=${payload.id}, pid=${pty.pid ?? '?'}) in ${cwd}`,
    );

    pty.onData((data) => {
      this.send(ws, { type: 'terminal.output', payload: { id: payload.id, data } });
    });
    pty.onExit(({ exitCode, signal }) => {
      map.delete(payload.id);
      this.send(ws, {
        type: 'terminal.exit',
        payload: { id: payload.id, exitCode, signal: signal ?? undefined },
      });
    });
  }

  private input(ws: WebSocket, payload: { id: string; data: string }): void {
    const pty = this.sessions.get(ws)?.get(payload.id);
    if (pty) pty.write(payload.data.slice(0, MAX_INPUT_BYTES));
  }

  private resize(ws: WebSocket, payload: { id: string; cols: number; rows: number }): void {
    const pty = this.sessions.get(ws)?.get(payload.id);
    if (!pty) return;
    try {
      pty.resize(clampDim(payload.cols, DEFAULT_COLS), clampDim(payload.rows, DEFAULT_ROWS));
    } catch {
      /* pty already gone */
    }
  }

  private close(ws: WebSocket, id: string): void {
    const map = this.sessions.get(ws);
    const pty = map?.get(id);
    if (!pty) return;
    map?.delete(id);
    this.killPty(pty, 'terminal close');
  }

  private disposeClient(ws: WebSocket): void {
    const map = this.sessions.get(ws);
    if (!map) return;
    for (const pty of map.values()) {
      this.killPty(pty, 'terminal client dispose');
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
      // when the WebUI server is hosted by Electron.
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
  try {
    cachedNodePty = requireFromHere('node-pty') as NodePtyApi;
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
