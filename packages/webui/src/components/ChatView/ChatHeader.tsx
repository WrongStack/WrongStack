import {
  Activity,
  AlertTriangle,
  Brain,
  ChevronDown,
  Cpu,
  History,
  PanelLeftOpen,
  Pencil,
  Terminal,
  Wand2,
  Zap,
} from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SessionHistoryEntry } from '@/stores';
import { useUIStore } from '@/stores';
import { AutonomyPicker } from '../AutonomyPicker';
import { ContextFillBar } from '../ContextBar';
import { ContextModePicker } from '../ContextModePicker';
import { CostChip } from '../CostChip';
import { ModePicker } from '../ModePicker';
import { Button } from '../ui/button';
import { fmtTok } from './utils.js';

export function ChatHeader({
  sidebarOpen,
  toggleSidebar,
  agentState,
  stateTone,
  sessionId,
  renamingTitle,
  setRenamingTitle,
  titleDraft,
  setTitleDraft,
  nickname,
  sessionTitle,
  setSessionNickname,
  historyEntries,
  switcherRef,
  switcherOpen,
  setSwitcherOpen,
  handleHistorySelect,
  provider,
  model,
  iteration,
  autonomy,
  handleAutonomyChange,
  memoryPanelOpen,
  setMemoryPanelOpen,
  activeMemoryCount,
  processOpen,
  setProcessOpen,
  checkpointOpen,
  setCheckpointOpen,
  hasStatusContent,
  lastInputTokens,
  ctxPct,
  maxContext,
  cacheStats,
  setBreakdownOpen,
  contextLimitWarning,
  setEditorOpen,
  totalTokens,
  startTime,
  formatDuration,
}: {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  agentState: 'idle' | 'streaming' | 'thinking';
  stateTone: string;
  sessionId?: string;
  renamingTitle: boolean;
  setRenamingTitle: (val: boolean) => void;
  titleDraft: string;
  setTitleDraft: (val: string) => void;
  nickname?: string;
  sessionTitle?: string;
  setSessionNickname: (id: string, name: string) => void;
  historyEntries: SessionHistoryEntry[];
  switcherRef: React.RefObject<HTMLDivElement | null>;
  switcherOpen: boolean;
  setSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleHistorySelect: (id: string) => void;
  provider?: string;
  model?: string;
  iteration?: { index: number; max: number } | null;
  autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  handleAutonomyChange: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => void;
  memoryPanelOpen: boolean;
  setMemoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  activeMemoryCount: number;
  processOpen: boolean;
  setProcessOpen: React.Dispatch<React.SetStateAction<boolean>>;
  checkpointOpen: boolean;
  setCheckpointOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasStatusContent: boolean;
  lastInputTokens: number;
  ctxPct: number;
  maxContext: number;
  cacheStats?: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    coverageTokens: number;
  } | null;
  setBreakdownOpen: (val: boolean) => void;
  contextLimitWarning: { previousMaxContext: number; maxContext: number } | null;
  setEditorOpen: (val: boolean) => void;
  totalTokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  startTime: number | null;
  formatDuration: (start: number | null) => string;
}) {
  const { t } = useAppTranslation();
  const cachedTokens = Math.max(0, totalTokens.cacheRead ?? 0);
  const totalPromptTokens = Math.max(
    0,
    totalTokens.input + cachedTokens + (totalTokens.cacheWrite ?? 0),
  );
  const freshTokens = Math.max(0, totalPromptTokens - cachedTokens);
  const cacheHitPct =
    totalPromptTokens > 0
      ? Math.min(100, Math.max(0, (cachedTokens / totalPromptTokens) * 100))
      : 0;
  const freshPct = totalPromptTokens > 0 ? 100 - cacheHitPct : 0;

  return (
    <header className="flex flex-col border-b border-border/70 bg-card/90 backdrop-blur-xl supports-[backdrop-filter]:bg-card/80 shrink-0 sticky top-0 z-20 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-1.5 overflow-hidden">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={toggleSidebar}
              title={t('chat:header.openSidebarTitle')}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
          {!sidebarOpen && (
            <div className="flex items-center gap-1.5 shrink-0 mr-1">
              <div className="w-5 h-5 rounded-md bg-primary flex items-center justify-center">
                <Zap className="h-3 w-3 text-primary-foreground" />
              </div>
            </div>
          )}
          <span
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium shrink-0 tabular-nums',
              stateTone,
            )}
            title={`Agent state: ${agentState}`}
          >
            {agentState !== 'idle' && (
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            )}
            <span>{agentState}</span>
          </span>
          {sessionId &&
            (renamingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft);
                  setRenamingTitle(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft);
                    setRenamingTitle(false);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingTitle(false);
                  }
                }}
                placeholder={t('chat:sessionNamePlaceholder')}
                className="h-6 px-1.5 text-[11px] bg-background border border-primary/40 rounded-md focus:outline-none focus:ring-1 focus:ring-ring shrink-0 w-36"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(nickname || sessionTitle || '');
                  setRenamingTitle(true);
                }}
                className="flex items-center gap-1 text-[11px] font-medium text-foreground/80 hover:text-foreground truncate max-w-[12rem] shrink-0 px-1 -mx-1 rounded-md hover:bg-muted/50 transition-colors"
                title={t('chat:header.renameTitle')}
              >
                <Pencil className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                <span className="truncate">
                  {nickname || sessionTitle || t('chat:header.untitled')}
                </span>
              </button>
            ))}
        </div>

        <div className="flex min-w-0 flex-[0_1_auto] flex-wrap items-center justify-end gap-1.5">
          {historyEntries.length > 1 && (
            <div ref={switcherRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setSwitcherOpen((v) => !v)}
                className="flex items-center gap-0.5 px-1 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title={t('chat:switchSession')}
              >
                <History className="h-3 w-3" />
                <ChevronDown className="h-2.5 w-2.5" />
              </button>
              {switcherOpen && (
                <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-md border border-border/70 bg-popover shadow-xl p-1 max-h-60 overflow-y-auto">
                  {historyEntries.slice(0, 15).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => handleHistorySelect(e.id)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors',
                        e.isCurrent && 'bg-primary/10',
                      )}
                    >
                      <div className="font-medium truncate">{e.title || t('chat:empty')}</div>
                      <div className="text-[10px] text-muted-foreground font-mono truncate">
                        {e.provider}/{e.model} · {e.tokenTotal.toLocaleString()} tok
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => useUIStore.getState().setModelSwitcherOpen(true)}
            className="group hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-md border border-border/70 bg-background/60 hover:bg-accent/70 hover:border-primary/40 transition-colors text-[11px] min-w-0 shrink-0"
            title={t('chat:header.changeModelTitle')}
          >
            <Cpu className="h-3 w-3 text-muted-foreground group-hover:text-foreground shrink-0" />
            <span className="font-mono truncate max-w-[9rem] xl:max-w-[16rem]">
              <span className="text-muted-foreground">
                {provider || t('chat:header.noProvider')}
              </span>
              <span className="text-muted-foreground/65 mx-0.5">/</span>
              <span className="font-medium">{model || t('chat:header.noModel')}</span>
            </span>
          </button>
          <div className="hidden md:flex items-center gap-1.5 shrink-0">
            <ModePicker />
            <ContextModePicker />
          </div>
          {iteration && (
            <button
              type="button"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-primary/10 text-primary shrink-0 hover:bg-primary/20 transition-colors cursor-pointer"
              title={t('chat:header.iterationTitle')}
              onClick={() =>
                document
                  .getElementById('chat-activity')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            >
              <Activity className="h-3 w-3 animate-pulse" />
              iter {iteration.index}
              {iteration.max > 0 ? `/${iteration.max}` : ''}
            </button>
          )}
          <AutonomyPicker value={autonomy} onChange={handleAutonomyChange} compact />
        </div>

        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <Button
            variant={memoryPanelOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn('h-7 w-7 relative', memoryPanelOpen && 'bg-primary/10 text-primary')}
            onClick={() => setMemoryPanelOpen((v) => !v)}
            title={t('chat:header.memoryContextTitle', 'Memory context')}
          >
            <Brain className="h-4 w-4" />
            {activeMemoryCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center tabular-nums">
                {activeMemoryCount}
              </span>
            )}
            {memoryPanelOpen && (
              <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
            )}
          </Button>
          <Button
            variant={processOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn('h-7 w-7 relative', processOpen && 'bg-warning/10 text-warning')}
            onClick={() => setProcessOpen((v) => !v)}
            title={t('chat:header.runningProcessesTitle')}
          >
            <Terminal className="h-4 w-4" />
            {processOpen && (
              <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-warning" />
            )}
          </Button>
          <Button
            variant={checkpointOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn('h-7 w-7 relative', checkpointOpen && 'bg-primary/10 text-primary')}
            onClick={() => setCheckpointOpen((v) => !v)}
            title={t('chat:header.checkpointsTitle')}
          >
            <History className="h-4 w-4" />
            {checkpointOpen && (
              <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
            )}
          </Button>
        </div>
      </div>

      {hasStatusContent && (
        <div className="flex items-center justify-between gap-3 overflow-x-auto border-t border-border/60 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
          <div className="flex min-w-max items-center gap-3 tabular-nums">
            {lastInputTokens > 0 && (
              <ContextFillBar
                pct={ctxPct}
                tokens={lastInputTokens}
                maxTokens={maxContext > 0 ? maxContext : undefined}
                {...(cacheStats ? { cache: cacheStats } : {})}
                onClick={() => setBreakdownOpen(true)}
              />
            )}
            {contextLimitWarning && (
              <span
                role="status"
                className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 font-medium text-warning"
                title={t('activity:chatView.providerLimitDecreased', {
                  previous: contextLimitWarning.previousMaxContext.toLocaleString(),
                  current: contextLimitWarning.maxContext.toLocaleString(),
                })}
              >
                <AlertTriangle className="h-3 w-3" />
                {t('activity:chatView.providerLimit', {
                  limit: fmtTok(contextLimitWarning.maxContext),
                })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors shrink-0"
              title={t('activity:chatView.editContextWindow')}
            >
              <Wand2 className="h-3 w-3" />
              <span>{t('activity:chatView.edit')}</span>
            </button>
            {totalPromptTokens > 0 && (
              <>
                <span className="flex items-center gap-1" title="Total prompt context">
                  <span className="font-medium text-foreground">{fmtTok(totalPromptTokens)}</span>
                  <span>context</span>
                </span>
                {cachedTokens > 0 && (
                  <span className="flex items-center gap-1" title="Prompt cache reads">
                    <span className="font-medium text-foreground">{fmtTok(cachedTokens)}</span>
                    <span>cached ({cacheHitPct.toFixed(1)}%)</span>
                  </span>
                )}
                <span className="flex items-center gap-1" title="Fresh/uncached prompt tokens">
                  <span className="font-medium text-foreground">{fmtTok(freshTokens)}</span>
                  <span>fresh ({freshPct.toFixed(1)}%)</span>
                </span>
                <span className="flex items-center gap-1" title="Completion tokens">
                  <span className="font-medium text-foreground">{fmtTok(totalTokens.output)}</span>
                  <span>completion</span>
                </span>
                <CostChip />
              </>
            )}
          </div>
          {startTime && (
            <span className="text-muted-foreground/70 tabular-nums shrink-0">
              {formatDuration(startTime)}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
