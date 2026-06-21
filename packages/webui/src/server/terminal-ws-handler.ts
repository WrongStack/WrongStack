import { type IPty, spawn } from 'node-pty';
import type { WebSocket } from 'ws';
import type { Logger } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WSServerMessage } from '../types.js';

/** Loose inbound shape — matches the server's internal WSClientMessage. */
type IncomingMessage = { type: string; payload?: unknown };

/** Hard cap on concurrent PTYs per connected client — a runaway-spawn backstop. */
const MAX_SESSIONS_PER_CLIENT = 8;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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
  private readonly sessions = new Map<WebSocket, Map<string, IPty>>();

  constructor(
    /** Resolves the cwd new terminals open in — tracks the live working dir. */
    private readonly getCwd: () => string,
    private readonly logger: Logger,
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
  handleMessage(ws: WebSocket, msg: IncomingMessage): boolean {
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case 'terminal.create':
        if (isStr(p.id)) this.create(ws, { id: p.id, cols: numOrUndef(p.cols), rows: numOrUndef(p.rows) });
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

  private create(ws: WebSocket, payload: { id: string; cols?: number | undefined; rows?: number | undefined }): void {
    const map = this.sessions.get(ws) ?? new Map<string, IPty>();
    this.sessions.set(ws, map);

    if (map.has(payload.id)) return; // idempotent — already running
    if (map.size >= MAX_SESSIONS_PER_CLIENT) {
      this.send(ws, {
        type: 'terminal.exit',
        payload: { id: payload.id, exitCode: -1 },
      });
      return;
    }

    const shell =
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/bash';

    let pty: IPty;
    try {
      pty = spawn(shell, [], {
        name: 'xterm-color',
        cols: clampDim(payload.cols, DEFAULT_COLS),
        rows: clampDim(payload.rows, DEFAULT_ROWS),
        cwd: this.getCwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.logger.warn?.(`terminal spawn failed: ${toErrorMessage(err)}`);
      this.send(ws, { type: 'terminal.exit', payload: { id: payload.id, exitCode: -1 } });
      return;
    }

    map.set(payload.id, pty);

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
    if (pty) pty.write(payload.data);
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
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
  }

  private disposeClient(ws: WebSocket): void {
    const map = this.sessions.get(ws);
    if (!map) return;
    for (const pty of map.values()) {
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    }
    this.sessions.delete(ws);
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  }
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Clamp a terminal dimension into a sane range; fall back to a default. */
function clampDim(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}
