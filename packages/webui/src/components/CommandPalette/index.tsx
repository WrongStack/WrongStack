import {
  ArchiveRestore,
  BarChart3,
  Bot,
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
  Rocket,
  RotateCcw,
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
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { playCompletionChime } from '@/lib/chime';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { cn } from '@/lib/utils';
import { navigateToView, openMainView, showPanel } from '@/lib/view-navigation';
import {
  useChatStore,
  useConfigStore,
  useGoalRunStore,
  useHistoryStore,
  useSessionTabStore,
  useUIStore,
} from '@/stores';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { SLASH_COMMANDS } from '../ChatInput/slash-commands.js';
import {
  type RunChatSlashCommandOptions,
  runChatSlashCommand,
} from '../ChatInput/slash-routing.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
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
  const setTheme = useConfigStore((s) => s.setTheme);
  const historyEntries = useHistoryStore((s) => s.entries);
  const { addMessage, clearMessages } = useChatStore(
    useShallow((s) => ({ addMessage: s.addMessage, clearMessages: s.clearMessages })),
  );
  const ws = useWebSocket();
  const { t } = useAppTranslation();

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
      // Ctrl+K toggles the palette from anywhere (including closed — Radix
      // Dialog only handles Escape + focus once it's open, so we still own
      // the open trigger). Escape-on-close is handled by Radix now.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUIStore.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      {
        id: 'help',
        category: 'Command',
        label: t('commandPalette:cmd.help'),
        icon: Hash,
        keywords: ['help', 'commands', '?'],
        run: () => {
          addMessage({
            role: 'assistant',
            content: 'Type `/` in the message box to see every slash command.',
          });
        },
      },
      {
        id: 'tools',
        category: 'Command',
        label: t('commandPalette:cmd.tools'),
        icon: Wrench,
        keywords: ['tools', 'list'],
        run: () => ws.listTools(),
      },
      {
        id: 'memory',
        category: 'Command',
        label: t('commandPalette:cmd.memory'),
        icon: Brain,
        keywords: ['memory', 'remember', 'notes', 'Sage'],
        run: () => openMainView('memory'),
      },
      {
        id: 'context',
        category: 'Command',
        label: t('activity:panels.contextDashboard'),
        icon: BarChart3,
        keywords: ['context', 'window', 'tokens', 'pressure', 'telemetry'],
        run: () => useUIStore.getState().setCurrentView('context'),
      },
      {
        id: 'skills',
        category: 'Command',
        label: t('commandPalette:cmd.skills'),
        icon: Sparkles,
        keywords: ['skills'],
        run: () => ws.listSkills(),
      },
      {
        id: 'diag',
        category: 'Command',
        label: t('commandPalette:cmd.diag'),
        icon: Stethoscope,
        keywords: ['diag', 'diagnostics', 'debug'],
        run: () => ws.getDiag(),
      },
      {
        id: 'stats',
        category: 'Command',
        label: t('commandPalette:cmd.stats'),
        icon: BarChart3,
        keywords: ['stats', 'tokens', 'cost', 'cache'],
        run: () => ws.getStats(),
      },
      {
        id: 'clear',
        category: 'Session',
        label: t('commandPalette:cmd.clear'),
        hint: t('commandPalette:cmd.clearHint'),
        icon: Trash2,
        keywords: ['clear', 'reset', 'wipe'],
        run: () => {
          streamCoalescer.dropAll();
          clearMessages();
          ws.client?.clearContext?.();
        },
      },
      {
        id: 'new',
        category: 'Session',
        label: t('commandPalette:cmd.new'),
        hint: t('commandPalette:cmd.newHint'),
        icon: RotateCcw,
        keywords: ['new', 'fresh', 'session'],
        run: () => {
          useSystemPromptStore.getState().openPicker({ startsSession: true });
          showPanel('chat');
        },
      },
      {
        id: 'compact',
        category: 'Session',
        label: t('commandPalette:cmd.compact'),
        icon: Database,
        keywords: ['compact', 'shrink', 'context'],
        run: () => ws.client?.compactContext?.(),
      },
      {
        id: 'repair-context',
        category: 'Session',
        label: t('commandPalette:cmd.repairContext'),
        hint: t('commandPalette:cmd.repairContextHint'),
        icon: Wrench,
        keywords: ['repair', 'context', 'tool_use', 'tool_result'],
        run: () => ws.client?.repairContext?.(),
      },
      {
        id: 'export',
        category: 'Session',
        label: t('commandPalette:cmd.export'),
        icon: Download,
        keywords: ['export', 'save', 'markdown', 'download'],
        run: () => downloadChatAsMarkdown(),
      },
      {
        id: 'export-html',
        category: 'Session',
        label: t('commandPalette:cmd.exportHtml'),
        hint: t('commandPalette:cmd.exportHtmlHint'),
        icon: Download,
        keywords: ['export', 'html', 'download', 'archive'],
        run: () => downloadChatAsHtml(),
      },
      {
        id: 'history',
        category: 'Command',
        label: t('commandPalette:cmd.history'),
        icon: HistoryIcon,
        keywords: ['history', 'sessions'],
        run: () => {
          showPanel('chat');
        },
      },
      {
        id: 'settings',
        category: 'Command',
        label: t('commandPalette:cmd.settings'),
        icon: SettingsIcon,
        keywords: ['settings', 'config'],
        run: () => openMainView('settings'),
      },
      {
        id: 'roster',
        category: 'Command',
        label: t('activity:agentRoster.heading'),
        icon: Bot,
        keywords: ['agents', 'roster', 'fleet', 'office', 'subagents'],
        run: () => openMainView('roster'),
      },
      {
        id: 'model',
        category: 'Command',
        label: t('commandPalette:cmd.model'),
        icon: Cpu,
        keywords: ['model', 'provider', 'change'],
        run: () => useUIStore.getState().setModelSwitcherOpen(true),
      },
      {
        id: 'theme-light',
        category: 'Theme',
        label: t('commandPalette:cmd.themeLight'),
        icon: Sun,
        keywords: ['theme', 'light', 'mode'],
        run: () => setTheme('light'),
      },
      {
        id: 'theme-dark',
        category: 'Theme',
        label: t('commandPalette:cmd.themeDark'),
        icon: Moon,
        keywords: ['theme', 'dark', 'mode'],
        run: () => setTheme('dark'),
      },
      {
        id: 'theme-system',
        category: 'Theme',
        label: t('commandPalette:cmd.themeSystem'),
        icon: Monitor,
        keywords: ['theme', 'system', 'auto'],
        run: () => setTheme('system'),
      },
      {
        id: 'compact-toggle',
        category: 'Command',
        label: t('commandPalette:cmd.compactToggle'),
        icon: Maximize2,
        hint: 'Ctrl+Shift+D',
        keywords: ['compact', 'dense', 'density', 'size'],
        run: () => useUIStore.getState().toggleCompactMode(),
      },
      {
        id: 'sound-toggle',
        category: 'Command',
        label: useConfigStore.getState().soundOnComplete
          ? t('commandPalette:cmd.soundOn')
          : t('commandPalette:cmd.soundOff'),
        icon: useConfigStore.getState().soundOnComplete ? Volume2 : VolumeX,
        hint: t('commandPalette:cmd.soundHint'),
        keywords: ['sound', 'audio', 'chime', 'notify', 'beep'],
        run: () => {
          const next = !useConfigStore.getState().soundOnComplete;
          useConfigStore.getState().setSoundOnComplete(next);
          if (next) playCompletionChime();
        },
      },
      // Goal commands
      {
        id: 'goal-open',
        category: 'Command',
        label: t('commandPalette:cmd.goalOpen'),
        icon: Rocket,
        keywords: ['goal', 'autonomous', 'phases', 'rocket'],
        run: () => openMainView('goal'),
      },
      {
        id: 'goal-toggle',
        category: 'Command',
        label: useGoalRunStore.getState().autonomous
          ? t('commandPalette:cmd.autoOn')
          : t('commandPalette:cmd.autoOff'),
        icon: useGoalRunStore.getState().autonomous ? Pause : Play,
        hint: t('commandPalette:cmd.autoHint'),
        keywords: ['autonomous', 'goal', 'auto', 'pause', 'resume'],
        run: () => {
          const next = !useGoalRunStore.getState().autonomous;
          ws.toggleGoalAutonomous(next);
        },
      },
      {
        id: 'goal-stop',
        category: 'Command',
        label: t('commandPalette:cmd.goalStop'),
        icon: Square,
        keywords: ['goal', 'stop', 'autonomous', 'end'],
        run: () => ws.stopGoal(),
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
        setCurrentView: (view) => navigateToView(view),
        toggleRefineEnabled: ui.toggleRefineEnabled,
        setProcessMonitorOpen: ui.setProcessMonitorOpen,
        setQueuePanelOpen: ui.setQueuePanelOpen,
        ws,
        onOpenBreakdown: () => navigateToView('debug'),
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
        id: `resume-${entry.id}`,
        category: 'Session',
        label: t('commandPalette:cmd.resume', {
          title: entry.title || t('commandPalette:cmd.emptyTitle'),
        }),
        hint: `${entry.provider}/${entry.model}`,
        icon: ArchiveRestore,
        keywords: ['resume', entry.title, entry.id, entry.provider, entry.model],
        run: () =>
          useSessionTabStore.getState().openTab(entry.id, {
            resumeSession: (id) => ws.resumeSession(id),
          }),
      });
    }
    return base;
  }, [historyEntries, ws, setTheme, addMessage, clearMessages, t]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((it) => {
      const hay = [it.label, it.hint ?? '', it.category, ...(it.keywords ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length, index]);

  const dispatchPick = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setOpen(false);
      }}
    >
      <DialogContent
        className="max-w-2xl gap-0 p-0 overflow-hidden pt-[14dvh]"
        // The palette has its own footer; hide the default Radix close X so
        // it doesn't overlap the search input. Escape + backdrop still work.
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // Focus the search input instead of the dialog container.
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {/* Visually-hidden accessible title/description so Radix's a11y
            contract is satisfied without cluttering the visual layout. */}
        <DialogTitle className="sr-only">{t('commandPalette:title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('commandPalette:placeholder')}</DialogDescription>
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette:placeholder')}
            aria-label={t('commandPalette:placeholder')}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (i + 1) % Math.max(1, filtered.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex(
                  (i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length),
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                dispatchPick(filtered[index]);
              }
            }}
          />
          <kbd className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div className="max-h-[60dvh] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('commandPalette:noMatches', { query })}
            </div>
          ) : (
            renderGroupedList(filtered, index, dispatchPick, setIndex)
          )}
        </div>

        <div className="border-t px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-3">
          <span>{t('commandPalette:footer.navigate')}</span>
          <span>{t('commandPalette:footer.select')}</span>
          <span>{t('commandPalette:footer.dismiss')}</span>
        </div>
      </DialogContent>
    </Dialog>
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
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {i18n.t(`commandPalette:cat.${cat}`, { defaultValue: cat })}
          </div>
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
                  {item.hint && (
                    <div className="text-xs text-muted-foreground truncate">{item.hint}</div>
                  )}
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
