import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/xterm';
import { bindTerminalTransport } from '@/lib/terminal-transport';
import { safeId } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useSessionStore, useUIStore } from '@/stores';
import '@xterm/xterm/css/xterm.css';
import { Plus, RotateCcw, TerminalSquare, Trash2, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useFontSettings } from '@/hooks/use-font-settings';
import { i18n, useAppTranslation } from '@/i18n';
import { terminalFontOptions } from '@/lib/fonts';
import {
  clampTerminalHeight,
  MIN_TERMINAL_HEIGHT,
  TERMINAL_HEIGHT_STORAGE_KEY,
} from '@/lib/terminal-dock';
import { cn } from '@/lib/utils';
import { noteTerminalOutput, useTerminalStripStore } from '@/stores/terminal-strip-store';

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

function defaultTerminalHeight(): number {
  if (typeof window === 'undefined') return 300;
  return clampTerminalHeight(window.innerHeight * 0.4);
}

function readStoredTerminalHeight(): number {
  if (typeof window === 'undefined') return defaultTerminalHeight();
  try {
    const raw = window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) ? clampTerminalHeight(parsed) : defaultTerminalHeight();
  } catch {
    return defaultTerminalHeight();
  }
}

function persistTerminalHeight(height: number): void {
  try {
    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(clampTerminalHeight(height)));
  } catch {
    /* best effort */
  }
}

/** Stable terminal id. Uses the shared browser-safe safeId helper. */
function newTerminalId(): string {
  return safeId();
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
 *
 * Hiding the dock (`hidden`) keeps its terminals running; the composer strip
 * shows them meanwhile. Closing the last one, or all, disposes the dock.
 */
export function TerminalPanel({
  hidden = false,
  onClose,
  onDispose,
}: {
  hidden?: boolean | undefined;
  /** Hide the dock; its terminals keep running. */
  onClose: () => void;
  /** Every terminal is closed: the dock can go. */
  onDispose: () => void;
}) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const { t } = useAppTranslation();
  const terminalCounterRef = useRef(1);
  const [height, setHeight] = useState(() => readStoredTerminalHeight());
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

  // The composer strip reads the terminals while the dock is hidden.
  useEffect(() => {
    useTerminalStripStore.getState().syncTabs(tabs);
  }, [tabs]);
  useEffect(() => () => useTerminalStripStore.getState().clear(), []);
  const focusRequest = useTerminalStripStore((s) => s.focusRequest);
  useEffect(() => {
    if (focusRequest && tabs.some((tab) => tab.id === focusRequest.id)) {
      setActiveId(focusRequest.id);
    }
  }, [focusRequest]);

  // Updaters must stay pure — the tab id side effects live outside setTabs
  // so a StrictMode double-invoke can't bump the counter or reselect twice.
  const addTerminal = () => {
    if (tabs.length >= MAX_TERMINALS) return;
    terminalCounterRef.current += 1;
    const next = createTerminalTab(terminalCounterRef.current);
    setTabs([...tabs, next]);
    setActiveId(next.id);
  };

  useEffect(() => {
    if (terminalCreateNonce === lastTerminalCreateNonceRef.current) return;
    lastTerminalCreateNonceRef.current = terminalCreateNonce;
    addTerminal();
  }, [terminalCreateNonce]);

  const closeTerminal = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (next.length === 0) {
      queueMicrotask(onDispose);
      return;
    }
    if (activeId === id) {
      setActiveId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? '');
    }
  };

  const restartTerminal = (id: string) => {
    const nextId = newTerminalId();
    if (!tabs.some((tab) => tab.id === id)) return;
    setTabs(
      tabs.map((tab) =>
        tab.id !== id
          ? tab
          : {
              ...tab,
              id: nextId,
              status: 'starting' as const,
              exitCode: undefined,
            },
      ),
    );
    setActiveId(nextId);
  };

  const closeAllTerminals = () => {
    setTabs([]);
    setActiveId('');
    queueMicrotask(onDispose);
  };

  const updateTabStatus = (
    id: string,
    patch: Pick<TerminalTab, 'status'> & Partial<Pick<TerminalTab, 'exitCode'>>,
  ) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  const maxTerminalHeight = clampTerminalHeight(Number.MAX_SAFE_INTEGER);

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLHRElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next: number | undefined;
    if (event.key === 'ArrowUp') next = height + step;
    else if (event.key === 'ArrowDown') next = height - step;
    else if (event.key === 'Home') next = MIN_TERMINAL_HEIGHT;
    else if (event.key === 'End') next = maxTerminalHeight;
    if (next === undefined) return;

    event.preventDefault();
    const clamped = clampTerminalHeight(next);
    setHeight(clamped);
    persistTerminalHeight(clamped);
  };

  return (
    <div
      data-terminal-dock
      style={{ height }}
      className={cn(
        'z-30 flex min-h-0 shrink-0 flex-col border-t border-border/70 bg-card ws-dialog',
        hidden && 'hidden',
      )}
      {...(hidden ? { 'aria-hidden': true } : {})}
    >
      <hr
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={maxTerminalHeight}
        aria-valuenow={height}
        tabIndex={0}
        title={t('activity:terminal.resize')}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
        className="h-1.5 cursor-ns-resize bg-muted/70 transition-colors hover:bg-primary/35 border-0"
      />
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-card/85 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="font-medium">{t('activity:terminal.labelPlural')}</span>
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
            title={t('activity:terminal.hideDock')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-[hsl(var(--surface-2)/0.45)] px-2 py-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'group inline-flex items-center rounded border text-xs transition-colors',
              'h-7 min-w-[112px] max-w-[180px]',
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
                  tab.status === 'running' && 'bg-success',
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
      {cwd && (
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
            onExit={(exitCode) => updateTabStatus(tab.id, { status: 'exited', exitCode })}
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
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [lostOutput, setLostOutput] = useState(false);
  const [exited, setExited] = useState(false);
  const { t } = useAppTranslation('activity');
  const { terminal: terminalFont } = useFontSettings();

  useEffect(() => {
    onRunningRef.current = onRunning;
    onExitRef.current = onExit;
  }, [onExit, onRunning]);

  // xterm can't read CSS variables — push the terminal font settings in live
  // and refit, since glyph size changes the row/column count.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontFamily === terminalFont.fontFamily) {
      // Same stack, but a web font may have just finished loading. xterm only
      // re-measures cells on an option change, so bounce the family once.
      term.options.fontFamily = 'monospace';
    }
    term.options.fontFamily = terminalFont.fontFamily;
    term.options.fontSize = terminalFont.fontSize;
    term.options.lineHeight = terminalFont.lineHeight;
    try {
      fitRef.current?.fit();
    } catch {
      /* container not laid out yet */
    }
  }, [terminalFont]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      ...terminalFontOptions(useConfigStore.getState().fonts),
      cursorBlink: true,
      theme: XTERM_THEME,
      scrollback: 5000,
      // `term.unicode` is a proposed API.
      allowProposedApi: true,
      disableStdin: true,
    });
    const fit = new FitAddon();
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    // xterm.js measures with Unicode 6 by default, where most emoji take one
    // column; the TUI (string-width) and the PTY host give them two. Unicode
    // 11 widths keep emoji rows of a TUI running here aligned.
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch {
      // Keep the default Unicode 6 widths.
    }
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }

    const disconnect = bindTerminalTransport({
      id,
      term,
      ws: getWSClient(wsUrl),
      onRunning: () => onRunningRef.current(),
      onOutput: (data) => noteTerminalOutput(id, data),
      onExit: ({ disconnected, exitCode }) => {
        setExited(true);
        const message = disconnected
          ? i18n.t('activity:terminal.resumeExpired')
          : i18n.t('activity:terminal.processExited', { code: exitCode });
        term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
        onExitRef.current(exitCode);
      },
      onReplayGap: () => setLostOutput(true),
    });
    const syncSize = () => {
      if (!container.offsetParent) return;
      try {
        fit.fit();
      } catch {
        /* not laid out */
      }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    return () => {
      ro.disconnect();
      disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, wsUrl]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          term.focus();
        }
      } catch {
        /* not laid out */
      }
    });
  }, [active, id]);

  return (
    <div className={cn('absolute inset-0 min-h-0 min-w-0', active ? 'block' : 'hidden')}>
      <div ref={containerRef} className="absolute inset-0 overflow-hidden px-2 py-1" />
      {(!wsConnected && !exited) || lostOutput ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-2 right-3 rounded bg-black/90 px-2 py-1 text-xs text-white"
        >
          {t(!wsConnected && !exited ? 'terminal.reconnecting' : 'terminal.replayGap')}
        </div>
      ) : null}
    </div>
  );
}
