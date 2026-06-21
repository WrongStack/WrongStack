import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

/** A reasonable dark palette — terminals read best dark regardless of app theme. */
const XTERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

/** Stable per-mount terminal id. crypto.randomUUID is available in all
 *  browsers that run this app; fall back to a timestamp-random combo. */
function newTerminalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `term-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * TerminalPanel — bottom-docked integrated terminal backed by a server-side
 * node-pty session (see server/terminal-ws-handler.ts). xterm.js renders;
 * keystrokes flow over WS as `terminal.input`, output as `terminal.output`.
 */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsConnected = useConfigStore((s) => s.wsConnected);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: XTERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }

    const id = newTerminalId();
    const ws = getWSClient(useConfigStore.getState().wsUrl);

    // Create the pty in the current working directory.
    ws.send({ type: 'terminal.create', payload: { id, cols: term.cols, rows: term.rows } });

    const offOut = ws.on('terminal.output', (msg: WSServerMessage) => {
      if (msg.type === 'terminal.output' && msg.payload.id === id) {
        term.write(msg.payload.data);
      }
    });
    const offExit = ws.on('terminal.exit', (msg: WSServerMessage) => {
      if (msg.type === 'terminal.exit' && msg.payload.id === id) {
        term.write(`\r\n\x1b[2m[process exited with code ${msg.payload.exitCode}]\x1b[0m\r\n`);
      }
    });

    const onData = term.onData((data) => {
      ws.send({ type: 'terminal.input', payload: { id, data } });
    });

    // Keep the pty's dimensions in sync with the panel size.
    const syncSize = () => {
      try {
        fit.fit();
        ws.send({ type: 'terminal.resize', payload: { id, cols: term.cols, rows: term.rows } });
      } catch {
        /* not laid out */
      }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    term.focus();

    return () => {
      offOut();
      offExit();
      onData.dispose();
      ro.disconnect();
      ws.send({ type: 'terminal.close', payload: { id } });
      term.dispose();
    };
    // Re-mount the terminal (fresh pty) whenever the WS (re)connects — a
    // reconnect spawns a new server-side socket with no pty for the old id.
  }, [wsConnected]);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 h-[40vh] min-h-[200px] flex flex-col border-t border-border bg-[#1e1e2e] shadow-2xl">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-[#181825]">
        <div className="flex items-center gap-2 text-xs text-[#cdd6f4]">
          <TerminalSquare className="h-3.5 w-3.5" />
          <span className="font-medium">Terminal</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close terminal (Ctrl+`)"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-[#a6adc8] hover:bg-white/10 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
