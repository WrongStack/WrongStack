import { cn } from '@/lib/utils';
import {
  useChatStore,
  useConfigStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import {
  Command,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  Settings,
  Sun,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useTheme } from './ThemeProvider';

/**
 * TopBar — Persistent header with session info, connection status,
 * context usage, and quick actions.
 */
export function TopBar() {
  const { wsConnected, wsStatus, provider, model } = useConfigStore();
  const { totalTokens, cost, lastInputTokens, maxContext } = useSessionStore();
  const isLoading = useChatStore((s) => s.isLoading);
  const compactMode = useUIStore((s) => s.compactMode);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const toggleCompactMode = useUIStore((s) => s.toggleCompactMode);
  const { theme, setTheme } = useTheme();

  const ctxPercent =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

  const ctxColor =
    ctxPercent >= 90
      ? 'bg-red-500'
      : ctxPercent >= 75
        ? 'bg-orange-500'
        : ctxPercent >= 50
          ? 'bg-amber-500'
          : 'bg-emerald-500';

  return (
    <header
      className={cn(
        'shrink-0 border-b bg-card/80 backdrop-blur-sm flex items-center justify-between transition-all duration-200',
        compactMode ? 'px-3 py-1.5' : 'px-4 py-2.5',
      )}
    >
      {/* Left — Logo + Status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold tracking-tight text-sm hidden sm:inline">
            WrongStack
          </span>
        </div>

        {/* Connection status */}
        <div
          className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-colors',
            wsConnected
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-red-500/10 text-red-600 dark:text-red-400',
          )}
          title={
            wsStatus.state === 'reconnecting'
              ? `Reconnecting (attempt ${wsStatus.attempt})`
              : wsConnected
                ? 'Connected to backend'
                : (wsStatus.state === 'closed' && wsStatus.error) || 'Disconnected'
          }
        >
          {wsConnected ? (
            <Wifi className="h-3 w-3" />
          ) : wsStatus.state === 'reconnecting' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <WifiOff className="h-3 w-3" />
          )}
          <span className="hidden sm:inline">
            {wsStatus.state === 'reconnecting'
              ? `Reconnecting ${wsStatus.attempt}`
              : wsConnected
                ? 'Connected'
                : 'Disconnected'}
          </span>
        </div>

        {/* Model chip */}
        {provider && model && (
          <button
            type="button"
            onClick={() => setCurrentView('settings')}
            className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
            title="Click to change model"
          >
            <span className="truncate max-w-[120px]">{provider}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="truncate max-w-[160px]">{model}</span>
          </button>
        )}
      </div>

      {/* Center — Context usage */}
      {maxContext > 0 && (
        <div className="hidden lg:flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Context</span>
            <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-500', ctxColor)}
                style={{ width: `${ctxPercent}%` }}
              />
            </div>
            <span className="font-mono tabular-nums">{ctxPercent}%</span>
            <span className="text-muted-foreground/60">
              ({lastInputTokens.toLocaleString()} / {maxContext.toLocaleString()})
            </span>
          </div>
        </div>
      )}

      {/* Right — Actions */}
      <div className="flex items-center gap-1">
        {/* Cost */}
        {cost > 0 && (
          <span className="hidden sm:inline text-xs font-mono text-muted-foreground mr-2">
            ${cost.toFixed(4)}
          </span>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs mr-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="hidden sm:inline">Running</span>
          </div>
        )}

        {/* Compact toggle */}
        <button
          type="button"
          onClick={toggleCompactMode}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={compactMode ? 'Expand layout' : 'Compact layout'}
        >
          {compactMode ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={`Theme: ${theme}`}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* Command palette shortcut */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setPaletteOpen(true)}
          className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted text-xs text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <Command className="h-3 w-3" />
          <span>⌘K</span>
        </button>

        {/* Settings */}
        <button
          type="button"
          onClick={() => setCurrentView('settings')}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
