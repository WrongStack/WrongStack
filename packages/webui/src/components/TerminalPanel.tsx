import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useSessionStore, useUIStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useAppTranslation, i18n } from '@/i18n';
import {
  clampTerminalHeight,
  TERMINAL_HEIGHT_STORAGE_KEY,
} from '@/lib/terminal-dock';
import { cn } from '@/lib/utils';

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

const MAX_TERMINALS = 8;

interface TerminalTab {
  id: string;
  name: string;
  status: 'starting' | 'running' | 'exited';
  exitCode?: number | undefined;
}

function defaultTerminalHeight(compact = false): number {
  if (typeof window === 'undefined') return 300;
  return clampTerminalHeight(window.innerHeight * (compact ? 0.32 : 0.4));
}

function readStoredTerminalHeight(compact = false): number {
  if (typeof window === 'undefined') return defaultTerminalHeight(compact);
  try {
    const raw = window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) ? clampTerminalHeight(parsed) : defaultTerminalHeight(compact);
  } catch {
    return defaultTerminalHeight(compact);
  }
}

function persistTerminalHeight(height: number): void {
  try {
    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(clampTerminalHeight(height)));
  } catch {
    /* best effort */
  }
}

/** Stable terminal id. crypto.randomUUID is available in all browsers that run
 *  this app; fall back to a timestamp-random combo. */
function newTerminalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `term-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function createTerminalTab(index: number): TerminalTab {
  return {
    id: newTerminalId(),
    name: `Terminal ${index}`,
    status: 'starting',
  };
}

/**
 * TerminalPanel — integrated bottom dock backed by server-side node-pty
 * sessions (see server/terminal-ws-handler.ts). It now manages multiple PTYs
 * per project WebUI connection through tabs while keeping the dock itself in
 * the normal flex layout, so the main app remains scrollable.
 */
export function TerminalPanel({
  desktopShell = false,
  onClose,
}: {
  desktopShell?: boolean | undefined;
  onClose: () => void;
}) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const { t } = useAppTranslation();
  const terminalCounterRef = useRef(1);
  const [height, setHeight] = useState(() => readStoredTerminalHeight(desktopShell));
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? '');
  const terminalCreateNonce = useUIStore((s) => s.terminalCreateNonce);
  const lastTerminalCreateNonceRef = useRef(terminalCreateNonce);
  const projectName = useSessionStore((s) => s.projectName);
  const cwd = useSessionStore((s) => s.cwd);

  useEffect(() => {
    const onResize = () => {
      setHeight((current) => {
        const next = clampTerminalHeight(current);
        persistTerminalHeight(next);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startY = event.clientY;
    const startHeight = height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampTerminalHeight(startHeight + startY - moveEvent.clientY);
      setHeight(next);
      persistTerminalHeight(next);
    };

    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  };

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const addTerminal = () => {
    setTabs((current) => {
      if (current.length >= MAX_TERMINALS) return current;
      terminalCounterRef.current += 1;
      const next = createTerminalTab(terminalCounterRef.current);
      setActiveId(next.id);
      return [...current, next];
    });
  };

  useEffect(() => {
    if (terminalCreateNonce === lastTerminalCreateNonceRef.current) return;
    lastTerminalCreateNonceRef.current = terminalCreateNonce;
    addTerminal();
  }, [terminalCreateNonce]);

  const closeTerminal = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index === -1) return current;
      const next = current.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        queueMicrotask(onClose);
        return next;
      }
      if (activeId === id) {
        setActiveId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? '');
      }
      return next;
    });
  };

  const restartTerminal = (id: string) => {
    const nextId = newTerminalId();
    setTabs((current) => {
      let found = false;
      const next = current.map((tab) => {
        if (tab.id !== id) return tab;
        found = true;
        return {
          ...tab,
          id: nextId,
          status: 'starting' as const,
          exitCode: undefined,
        };
      });
      if (found) setActiveId(nextId);
      return next;
    });
  };

  const closeAllTerminals = () => {
    setTabs([]);
    setActiveId('');
    queueMicrotask(onClose);
  };

  const updateTabStatus = (
    id: string,
    patch: Pick<TerminalTab, 'status'> & Partial<Pick<TerminalTab, 'exitCode'>>,
  ) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    );
  };

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;

  return (
    <div
      data-terminal-dock
      style={{ height }}
      data-shell={desktopShell ? 'desktop' : 'browser'}
      className={cn(
        'z-30 flex min-h-0 shrink-0 flex-col border-t border-border/70 bg-card shadow-2xl',
        desktopShell && 'ws-terminal-desktop',
      )}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        title={t('activity:terminal.resize')}
        onPointerDown={startResize}
        className="h-1.5 cursor-ns-resize bg-muted/70 transition-colors hover:bg-primary/35"
      />
      <div
        className={cn(
          'flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-card/85',
          desktopShell ? 'px-2 py-1' : 'px-3 py-1.5',
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="font-medium">{desktopShell ? t('activity:terminal.labelSingular') : t('activity:terminal.labelPlural')}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {projectName || cwd || t('activity:terminal.projectShell')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={addTerminal}
            disabled={tabs.length >= MAX_TERMINALS}
            title={
              tabs.length >= MAX_TERMINALS
                ? t('activity:terminal.maxTerminals', { count: MAX_TERMINALS })
                : t('activity:terminal.newTerminal')
            }
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => activeTab && restartTerminal(activeTab.id)}
            disabled={!activeTab}
            title={t('activity:terminal.restart')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={closeAllTerminals}
            disabled={tabs.length === 0}
            title={t('activity:terminal.closeAll')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('activity:terminal.closeDock')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-[hsl(var(--surface-2)/0.45)]',
          desktopShell ? 'px-1.5 py-0.5' : 'px-2 py-1',
        )}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'group inline-flex items-center rounded border text-xs transition-colors',
              desktopShell ? 'h-6 min-w-[92px] max-w-[148px]' : 'h-7 min-w-[112px] max-w-[180px]',
              activeId === tab.id
                ? 'border-primary/35 bg-primary/10 text-primary'
                : 'border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => setActiveId(tab.id)}
              title={tab.status === 'exited' ? `${tab.name} exited` : tab.name}
              className="inline-flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  tab.status === 'running' && 'bg-[hsl(var(--success))]',
                  tab.status === 'starting' && 'bg-primary',
                  tab.status === 'exited' && 'bg-destructive',
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {tab.name}
                {tab.status === 'exited' && typeof tab.exitCode === 'number'
                  ? ` (${tab.exitCode})`
                  : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeTerminal(tab.id);
              }}
              className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground hover:opacity-100"
              title={t('activity:terminal.closeTab', { name: tab.name })}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      {cwd && !desktopShell && (
        <div className="min-w-0 truncate border-b border-border/60 bg-muted/30 px-3 py-1 text-[11px] font-mono text-muted-foreground">
          {cwd}
        </div>
      )}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.id}
            id={tab.id}
            active={tab.id === activeId}
            onRunning={() => updateTabStatus(tab.id, { status: 'running' })}
            onExit={(exitCode) =>
              updateTabStatus(tab.id, { status: 'exited', exitCode })
            }
          />
        ))}
      </div>
    </div>
  );
}

function TerminalSession({
  id,
  active,
  onRunning,
  onExit,
}: {
  id: string;
  active: boolean;
  onRunning: () => void;
  onExit: (exitCode: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onRunningRef = useRef(onRunning);
  const onExitRef = useRef(onExit);
  const wsConnected = useConfigStore((s) => s.wsConnected);

  useEffect(() => {
    onRunningRef.current = onRunning;
    onExitRef.current = onExit;
  }, [onExit, onRunning]);

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
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }

    const ws = getWSClient(useConfigStore.getState().wsUrl);

    ws.send({ type: 'terminal.create', payload: { id, cols: term.cols, rows: term.rows } });
    onRunningRef.current();

    const offOut = ws.on('terminal.output', (msg: WSServerMessage) => {
      if (msg.type === 'terminal.output' && msg.payload.id === id) {
        term.write(msg.payload.data);
      }
    });
    const offExit = ws.on('terminal.exit', (msg: WSServerMessage) => {
      if (msg.type === 'terminal.exit' && msg.payload.id === id) {
        term.write(`\r\n\x1b[2m${i18n.t('activity:terminal.processExited', { code: msg.payload.exitCode })}\x1b[0m\r\n`);
        onExitRef.current(msg.payload.exitCode);
      }
    });

    const onData = term.onData((data) => {
      ws.send({ type: 'terminal.input', payload: { id, data } });
    });

    const syncSize = () => {
      if (!container.offsetParent) return;
      try {
        fit.fit();
        ws.send({ type: 'terminal.resize', payload: { id, cols: term.cols, rows: term.rows } });
      } catch {
        /* not laid out */
      }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    return () => {
      offOut();
      offExit();
      onData.dispose();
      ro.disconnect();
      ws.send({ type: 'terminal.close', payload: { id } });
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Re-create the pty after a WebSocket reconnect because the new server-side
    // socket has no process for the previous terminal id.
  }, [id, wsConnected]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          getWSClient(useConfigStore.getState().wsUrl).send({
            type: 'terminal.resize',
            payload: { id, cols: term.cols, rows: term.rows },
          });
          term.focus();
        }
      } catch {
        /* not laid out */
      }
    });
  }, [active, id]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 min-h-0 min-w-0 overflow-hidden px-2 py-1',
        active ? 'block' : 'hidden',
      )}
    />
  );
}
