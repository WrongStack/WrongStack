import { useWebSocket } from '@/hooks/useWebSocket';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import {
  useAutoPhaseStore,
  useChatStore,
  useConfigStore,
  useHistoryStore,
  useUIStore,
} from '@/stores';
import {
  ArchiveRestore,
  BarChart3,
  Brain,
  Cpu,
  Database,
  Download,
  Hash,
  History as HistoryIcon,
  type LucideIcon,
  Maximize2,
  Monitor,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Rocket,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Stethoscope,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SLASH_COMMANDS } from '../ChatInput/slash-commands.js';
import {
  type RunChatSlashCommandOptions,
  runChatSlashCommand,
} from '../ChatInput/slash-routing.js';
import { downloadChatAsHtml, downloadChatAsMarkdown } from './export-utils.js';

interface PaletteItem {
  id: string;
  category: 'Command' | 'Session' | 'Theme' | 'Tool' | 'Slash';
  label: string;
  hint?: string | undefined;
  icon: LucideIcon;
  keywords?: string[] | undefined;
  run: () => void;
}

export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setOpen = useUIStore((s) => s.setPaletteOpen);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setTheme = useConfigStore((s) => s.setTheme);
  const { entries: historyEntries } = useHistoryStore();
  const { addMessage, clearMessages } = useChatStore();
  const ws = useWebSocket();

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUIStore.getState().paletteOpen);
        return;
      }
      if (e.key === 'Escape' && useUIStore.getState().paletteOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      {
        id: 'help', category: 'Command', label: 'Show slash commands',
        icon: Hash, keywords: ['help', 'commands', '?'],
        run: () => { addMessage({ role: 'assistant', content: 'Type `/` in the message box to see every slash command.' }); },
      },
      {
        id: 'tools', category: 'Command', label: 'List tools',
        icon: Wrench, keywords: ['tools', 'list'],
        run: () => ws.listTools(),
      },
      {
        id: 'memory', category: 'Command', label: 'Show memory',
        icon: Brain, keywords: ['memory', 'remember', 'notes'],
        run: () => ws.listMemory(),
      },
      {
        id: 'skills', category: 'Command', label: 'List skills',
        icon: Sparkles, keywords: ['skills'],
        run: () => ws.listSkills(),
      },
      {
        id: 'diag', category: 'Command', label: 'Runtime diagnostics',
        icon: Stethoscope, keywords: ['diag', 'diagnostics', 'debug'],
        run: () => ws.getDiag(),
      },
      {
        id: 'stats', category: 'Command', label: 'Session stats (tokens, cache, cost)',
        icon: BarChart3, keywords: ['stats', 'tokens', 'cost', 'cache'],
        run: () => ws.getStats(),
      },
      {
        id: 'clear', category: 'Session', label: 'Clear context',
        hint: 'Wipe in-memory context, keep session id',
        icon: Trash2, keywords: ['clear', 'reset', 'wipe'],
        run: () => { clearMessages(); ws.client?.clearContext?.(); },
      },
      {
        id: 'new', category: 'Session', label: 'New session',
        hint: 'Brand-new on disk + memory',
        icon: RotateCcw, keywords: ['new', 'fresh', 'session'],
        run: () => {
          ws.client?.newSession?.();
          setCurrentView('chat');
        },
      },
      {
        id: 'compact', category: 'Session', label: 'Compact context',
        icon: Database, keywords: ['compact', 'shrink', 'context'],
        run: () => ws.client?.compactContext?.(),
      },
      {
        id: 'repair-context', category: 'Session', label: 'Repair context',
        hint: 'Remove orphan tool protocol blocks',
        icon: Wrench, keywords: ['repair', 'context', 'tool_use', 'tool_result'],
        run: () => ws.client?.repairContext?.(),
      },
      {
        id: 'export', category: 'Session', label: 'Export chat as markdown',
        icon: Download, keywords: ['export', 'save', 'markdown', 'download'],
        run: () => downloadChatAsMarkdown(),
      },
      {
        id: 'export-html', category: 'Session', label: 'Export chat as HTML',
        hint: 'Self-contained, opens in any browser',
        icon: Download, keywords: ['export', 'html', 'download', 'archive'],
        run: () => downloadChatAsHtml(),
      },
      {
        id: 'history', category: 'Command', label: 'Open history panel',
        icon: HistoryIcon, keywords: ['history', 'sessions'],
        run: () => {
          useUIStore.getState().setSidebarOpen(true);
          useUIStore.getState().selectActivity('history');
        },
      },
      {
        id: 'settings', category: 'Command', label: 'Open settings',
        icon: SettingsIcon, keywords: ['settings', 'config'],
        run: () => setCurrentView('settings'),
      },
      {
        id: 'model', category: 'Command', label: 'Change provider/model',
        icon: Cpu, keywords: ['model', 'provider', 'change'],
        run: () => useUIStore.getState().setModelSwitcherOpen(true),
      },
      { id: 'theme-light', category: 'Theme', label: 'Theme: Light', icon: Sun, keywords: ['theme', 'light', 'mode'], run: () => setTheme('light') },
      { id: 'theme-dark', category: 'Theme', label: 'Theme: Dark', icon: Moon, keywords: ['theme', 'dark', 'mode'], run: () => setTheme('dark') },
      { id: 'theme-system', category: 'Theme', label: 'Theme: Follow system', icon: Monitor, keywords: ['theme', 'system', 'auto'], run: () => setTheme('system') },
      {
        id: 'compact-toggle', category: 'Command', label: 'Toggle compact density',
        icon: Maximize2, hint: 'Ctrl+Shift+D', keywords: ['compact', 'dense', 'density', 'size'],
        run: () => useUIStore.getState().toggleCompactMode(),
      },
      {
        id: 'sound-toggle', category: 'Command',
        label: useConfigStore.getState().soundOnComplete ? 'Sound on completion: ON — turn off' : 'Sound on completion: OFF — turn on',
        icon: useConfigStore.getState().soundOnComplete ? Volume2 : VolumeX,
        hint: 'Chime when a run finishes', keywords: ['sound', 'audio', 'chime', 'notify', 'beep'],
        run: () => {
          const next = !useConfigStore.getState().soundOnComplete;
          useConfigStore.getState().setSoundOnComplete(next);
          if (next) playCompletionChime();
        },
      },
      // AutoPhase commands
      {
        id: 'autophase-open', category: 'Command', label: 'Open AutoPhase view',
        icon: Rocket, keywords: ['autophase', 'autonomous', 'phases', 'rocket'],
        run: () => setCurrentView('autophase'),
      },
      {
        id: 'autophase-toggle', category: 'Command',
        label: useAutoPhaseStore.getState().autonomous ? 'Autonomous mode: ON — disable' : 'Autonomous mode: OFF — enable',
        icon: useAutoPhaseStore.getState().autonomous ? Pause : Play,
        hint: 'Toggle autonomous phase execution',
        keywords: ['autonomous', 'autophase', 'auto', 'pause', 'resume'],
        run: () => {
          const next = !useAutoPhaseStore.getState().autonomous;
          ws.toggleAutoPhaseAutonomous(next);
        },
      },
      {
        id: 'autophase-stop', category: 'Command', label: 'Stop AutoPhase',
        icon: Square, keywords: ['autophase', 'stop', 'autonomous', 'end'],
        run: () => ws.stopAutoPhase(),
      },
    ];

    // Bridge every slash command into the palette so Ctrl+K can run them
    // all — not just the curated subset above. Picking one routes through
    // the same runChatSlashCommand the chat input uses.
    const buildSlashOptions = (raw: string): RunChatSlashCommandOptions => {
      const chat = useChatStore.getState();
      const ui = useUIStore.getState();
      const sendMsg = (content: string) => {
        if (chat.isLoading) {
          chat.enqueue(content);
          return;
        }
        chat.addMessage({ role: 'user', content });
        const id = ws.sendMessage(content);
        if (id) chat.setLoading(true);
      };
      return {
        raw,
        addMessage,
        clearMessages,
        client: ws.client,
        queue: chat.queue,
        sendAbort: ws.sendAbort,
        sendMsg,
        setLoading: chat.setLoading,
        setCurrentView,
        toggleRefineEnabled: ui.toggleRefineEnabled,
        setProcessMonitorOpen: ui.setProcessMonitorOpen,
        setQueuePanelOpen: ui.setQueuePanelOpen,
        ws,
        onOpenBreakdown: () => setCurrentView('debug'),
        handleNextList: () => false,
        handleNextSelect: () => false,
      };
    };
    for (const c of SLASH_COMMANDS) {
      if (c.hidden) continue;
      base.push({
        id: `slash-${c.name}`,
        category: 'Slash',
        label: c.name,
        hint: c.description,
        icon: Hash,
        keywords: [
          'slash',
          c.name.replace('/', ''),
          ...(c.aliases ?? []).map((a) => a.replace('/', '')),
        ],
        run: () => {
          runChatSlashCommand(buildSlashOptions(c.name));
        },
      });
    }

    for (const entry of historyEntries.slice(0, 10)) {
      if (entry.isCurrent) continue;
      base.push({
        id: `resume-${entry.id}`, category: 'Session',
        label: `Resume: ${entry.title || '(empty)'}`,
        hint: `${entry.provider}/${entry.model}`,
        icon: ArchiveRestore,
        keywords: ['resume', entry.title, entry.id, entry.provider, entry.model],
        run: () => ws.resumeSession(entry.id),
      });
    }
    return base;
  }, [historyEntries, ws, setCurrentView, setTheme, addMessage, clearMessages]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((it) => {
      const hay = [it.label, it.hint ?? '', it.category, ...(it.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  useEffect(() => { if (index >= filtered.length) setIndex(0); }, [filtered.length, index]);

  if (!open) return null;

  const dispatchPick = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-start justify-center pt-[14vh] px-4"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border bg-popover shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, sessions, settings…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % Math.max(1, filtered.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length)); }
              else if (e.key === 'Enter') { e.preventDefault(); dispatchPick(filtered[index]); }
            }}
          />
          <kbd className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No matches for "{query}"</div>
          ) : (
            renderGroupedList(filtered, index, dispatchPick, setIndex)
          )}
        </div>

        <div className="border-t px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>Esc dismiss</span>
        </div>
      </div>
    </div>
  );
}

function renderGroupedList(
  filtered: PaletteItem[],
  index: number,
  dispatch: (it: PaletteItem) => void,
  setIndex: (i: number) => void,
) {
  const groups: Record<string, Array<{ item: PaletteItem; globalIdx: number }>> = {};
  filtered.forEach((it, i) => {
    if (!groups[it.category]) groups[it.category] = [];
    groups[it.category]?.push({ item: it, globalIdx: i });
  });
  return (
    <div className="p-1">
      {Object.entries(groups).map(([cat, rows]) => (
        <div key={cat}>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{cat}</div>
          {rows.map(({ item, globalIdx }) => {
            const Icon = item.icon;
            const active = globalIdx === index;
            return (
              <button
                type="button"
                key={item.id}
                onMouseEnter={() => setIndex(globalIdx)}
                onClick={() => dispatch(item)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                )}
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.hint && <div className="text-xs text-muted-foreground truncate">{item.hint}</div>}
                </div>
                {active && <span className="text-[10px] text-muted-foreground">↵</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
