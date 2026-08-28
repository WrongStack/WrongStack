import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronUp } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { VList } from 'virtua';
import { MemoryInjectorPanel } from '@/components/MemoryManager/MemoryInjectorPanel';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import {
  useActiveSessionId,
  useConfigStore,
  useFleetStore,
  useSessionLeaderId,
  useUIStore,
} from '@/stores';
import { DEFAULT_LANE_ID } from '@/stores/chat-lanes';
import { ChatInput } from '../ChatInput';
import { CheckpointTimeline } from '../CheckpointTimeline';
import { ContextBreakdownModal } from '../ContextBreakdownModal';
import { ContextWindowEditor } from '../context-editor/ContextWindowEditor';
import { ProviderWaitingRoom } from '../ProviderWaitingRoom';
import { SearchOverlay } from '../SearchOverlay';
import { ToolStatsModal } from '../ToolStatsModal';
import { WelcomeScreen } from '../WelcomeScreen';
import { shouldAutoClearSubagentFocus } from './AgentTabs';
import { ChatDisplayToggles } from './ChatDisplayToggles';
import { ChatHeader } from './ChatHeader';
import { ChatRowView } from './ChatRowView';
import { SubagentTranscriptView } from './SubagentTranscriptView';
import { ThinkingBubble } from './ThinkingBubble.js';
import { ToggleSwitch } from './ToggleSwitch';
import { useChatViewState } from './useChatViewState';
import { fmtTok } from './utils.js';

const ProcessMonitor = lazy(() =>
  import('../ProcessMonitor').then((m) => ({ default: m.ProcessMonitor })),
);

export function ChatView() {
  const { t } = useAppTranslation();
  const state = useChatViewState();

  // ── Subagent chat focus (AgentTabs) ──────────────────────────────
  // Selection lives in ui-store so roster cards / detail sections can jump
  // straight into an agent's transcript.
  const currentSessionId = useActiveSessionId();
  const focusedSubagentId = useUIStore((s) => s.subagentChatFocusId);
  const setSubagentChatFocus = useUIStore((s) => s.setSubagentChatFocus);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const leaderId = useSessionLeaderId(currentSessionId ?? undefined);
  const focusedAgent = useFleetStore((s) =>
    focusedSubagentId != null ? s.agents.get(focusedSubagentId) : undefined,
  );
  const focusedAgentBelongsToCurrentSession =
    !focusedAgent || agentBelongsToSession(focusedAgent.sessionId, currentSessionId);
  const focusedAgentExists = Boolean(focusedAgent) && focusedAgentBelongsToCurrentSession;
  // The leader owns the main pane — a focus pointing at it (e.g. a stray
  // "open chat" on the leader's roster card) just means plain leader chat.
  const subagentMode =
    focusedSubagentId != null && focusedAgentExists && focusedSubagentId !== leaderId;

  // A selected agent can vanish at any moment (removed, clear-finished,
  // session stop), and a leader-directed focus is meaningless — both fall
  // back to the plain leader chat.
  useEffect(() => {
    if (
      shouldAutoClearSubagentFocus(focusedSubagentId, focusedAgentExists) ||
      (focusedSubagentId != null && focusedSubagentId === leaderId)
    ) {
      // Name the tab this clear belongs to: an unscoped write would stamp
      // `null` onto whichever session the flat pointer currently names,
      // which during a tab switch can be the one we just restored.
      setSubagentChatFocus(null, currentSessionId);
    }
  }, [focusedSubagentId, focusedAgentExists, leaderId, setSubagentChatFocus, currentSessionId]);

  // Entering a subagent tab parks the leader composer/overlay — close any open
  // search so the flag can't strand behind an inert pane.
  //
  // Coming back needs no scroll fix-up any more: the leader pane is parked,
  // not unmounted, so it keeps its offset and its row measurements. The old
  // forced `scrollToBottom()` existed only because the VList remounted at the
  // top, and it would now yank the user away from where they were reading.
  useEffect(() => {
    if (subagentMode) setSearchOpen(false);
  }, [subagentMode, setSearchOpen]);

  // Chimera report hydration: when this tab's session becomes active (or the
  // socket opens/reconnects), ask the server for the session's persisted
  // review reports so actionable cards survive page refreshes and tab
  // reopenings — the live `chimera.report_available` event alone cannot
  // backfill history. The response handler (handleChimeraReports) routes by
  // sessionId and only backfills cards the lane has not seen.
  const wsStatus = useConfigStore((s) => s.wsStatus);
  const hydratedSessionId = state.sessionId;
  useEffect(() => {
    if (!hydratedSessionId || wsStatus.state !== 'open') return;
    getWSClient().getChimeraReports(hydratedSessionId);
  }, [hydratedSessionId, wsStatus]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[hsl(var(--surface-2)/0.45)]">
      <ChatHeader
        sidebarOpen={state.sidebarOpen}
        toggleSidebar={state.toggleSidebar}
        agentState={state.agentState}
        stateTone={state.stateTone}
        sessionId={state.sessionId}
        renamingTitle={state.renamingTitle}
        setRenamingTitle={state.setRenamingTitle}
        titleDraft={state.titleDraft}
        setTitleDraft={state.setTitleDraft}
        nickname={state.nickname}
        sessionTitle={state.sessionTitle}
        setSessionNickname={state.setSessionNickname}
        historyEntries={state.historyEntries}
        switcherRef={state.switcherRef}
        switcherOpen={state.switcherOpen}
        setSwitcherOpen={state.setSwitcherOpen}
        handleHistorySelect={state.handleHistorySelect}
        iteration={state.iteration}
        autonomy={state.autonomy}
        handleAutonomyChange={state.handleAutonomyChange}
        memoryPanelOpen={state.memoryPanelOpen}
        setMemoryPanelOpen={state.setMemoryPanelOpen}
        activeMemoryCount={state.activeMemoryCount}
        processOpen={state.processOpen}
        setProcessOpen={state.setProcessOpen}
        checkpointOpen={state.checkpointOpen}
        setCheckpointOpen={state.setCheckpointOpen}
        toolStatsOpen={state.toolStatsOpen}
        setToolStatsOpen={state.setToolStatsOpen}
        hasStatusContent={state.hasStatusContent}
        lastInputTokens={state.lastInputTokens}
        ctxPct={state.ctxPct}
        maxContext={state.maxContext}
        cacheStats={state.cacheStats}
        setBreakdownOpen={state.setBreakdownOpen}
        contextLimitWarning={state.contextLimitWarning}
        setEditorOpen={state.setEditorOpen}
        totalTokens={state.totalTokens}
        startTime={state.startTime}
        formatDuration={state.formatDuration}
      />
      {/* Messages.
          Both panes stay MOUNTED; the one not in front is parked. The leader
          transcript is virtualized, so swapping it out for a subagent tab used
          to discard its row measurements and scroll offset — returning to the
          leader remounted the VList at the top and re-rendered every message.
          Parking keeps it measuring against this box, so coming back is a
          visibility flip. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'ws-view-pane relative mx-2 mt-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/55 shadow-sm sm:mx-3 lg:mx-4 lg:mt-3',
            !subagentMode && 'ws-view-parked',
          )}
          {...(!subagentMode ? { inert: true, 'aria-hidden': true } : {})}
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            {/* Only mounted while a subagent is focused: its transcript is a
                plain scroller with nothing worth preserving, and keying it by
                agent id is what resets the scroll between agents. */}
            {subagentMode && focusedSubagentId != null && (
              <SubagentTranscriptView key={focusedSubagentId} agentId={focusedSubagentId} />
            )}
          </div>
        </div>
        <div
          className={cn(
            'ws-view-pane relative mx-2 mt-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card/55 shadow-sm sm:mx-3 lg:mx-4 lg:mt-3',
            subagentMode && 'ws-view-parked',
          )}
          {...(subagentMode ? { inert: true, 'aria-hidden': true } : {})}
        >
          <SearchOverlay />
          {!state.pinnedToBottom && (
            <button
              type="button"
              onClick={state.scrollToBottom}
              className={cn(
                'absolute bottom-4 left-1/2 -translate-x-1/2 z-10 jump-bottom',
                'flex items-center gap-2 px-4 py-2 rounded-md shadow-lg',
                'bg-primary text-primary-foreground text-xs font-medium',
                'hover:bg-primary/90 transition-colors animate-message',
              )}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {state.unreadCount > 0
                ? `${state.unreadCount} new message${state.unreadCount === 1 ? '' : 's'}`
                : 'Jump to latest'}
            </button>
          )}
          {state.scrolledDeep && (
            <button
              type="button"
              onClick={state.scrollToTop}
              title={t('chat:header.scrollTopTitle')}
              className={cn(
                'absolute top-3 right-3 z-10',
                'flex items-center gap-1 px-2.5 py-1 rounded-md shadow-md border',
                'bg-background/90 backdrop-blur-sm text-[11px] text-muted-foreground',
                'hover:text-foreground hover:bg-background transition-colors animate-message',
              )}
            >
              <ArrowUp className="h-3 w-3" />
              <span>{t('activity:chatView.top')}</span>
            </button>
          )}
          {state.rows.length === 0 && !state.isLoading ? (
            <div className="h-full overflow-y-auto overscroll-contain">
              <div className="mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6 pt-4 pb-8">
                <WelcomeScreen />
              </div>
            </div>
          ) : (
            <VList
              key={state.sessionId ?? '__unbound__'}
              ref={state.vlistRef}
              className="h-full"
              onScroll={state.handleScroll}
              role="log"
              aria-label={t('activity:chatView.chatTranscript')}
              aria-live="polite"
            >
              {state.rows.map((row, i) => (
                <ChatRowView
                  key={row.key}
                  row={row}
                  isLoading={state.isLoading}
                  compactMode={state.compactMode}
                  isFirstRow={i === 0}
                  groupToolCalls={state.groupToolCallsPref}
                  sessionId={state.sessionId ?? DEFAULT_LANE_ID}
                />
              ))}

              {/* Trailing live-activity item */}
              <div
                key="__live"
                id="chat-activity"
                className={cn(
                  'mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6',
                  state.compactMode ? 'pb-3' : 'pb-8',
                )}
              >
                <ThinkingBubble />

                {/* Running status bubble */}
                {state.isLoading && (
                  <div className="flex gap-3 animate-message">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-accent text-accent-foreground ring-2 ring-offset-2 ring-offset-background ring-accent/20">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="rounded-lg px-4 py-3 bg-card border border-border/70 text-foreground shadow-sm">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="flex gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce" />
                          </span>
                          <span className="text-foreground/90">{state.runningStatus.label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {state.runningStatus.elapsed}
                          </span>
                          {state.iteration && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              · iter {state.iteration.index}
                              {state.iteration.max > 0 ? `/${state.iteration.max}` : ''}
                            </span>
                          )}
                          {state.runningStatus.speedLabel && (
                            <span className="text-xs text-muted-foreground/80 tabular-nums">
                              · {state.runningStatus.speedLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </VList>
          )}
        </div>
      </div>

      {/* Composer — parked, not unmounted, while reading a subagent's
          read-only transcript. Unmounting it discarded an unsent draft and
          any staged image attachments the moment a subagent tab was opened. */}
      <div
        className={cn(
          'ws-view-pane shrink-0 bg-[hsl(var(--surface-2)/0.45)] px-2 pb-2 pt-2 sm:px-3 lg:px-4 lg:pb-3',
          subagentMode && 'ws-view-parked',
        )}
        {...(subagentMode ? { inert: true, 'aria-hidden': true } : {})}
      >
        {state.inputCollapsed && state.messages.length > 0 ? (
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5 hover:bg-card/70 hover:border-border/80 transition-colors">
            <button
              type="button"
              onClick={() => state.setInputCollapsed(false)}
              className="flex flex-1 items-center gap-2 text-xs text-muted-foreground/60 hover:text-foreground/80 transition-colors"
            >
              <ChevronUp className="h-3.5 w-3.5 shrink-0" />
              <span>{t('chat:input.expandInput', 'Expand input')}</span>
              {state.rows.length > 0 && (
                <span className="ml-auto tabular-nums text-[10px] text-muted-foreground/40">
                  {state.rows.length} msgs ·{' '}
                  {fmtTok(state.totalTokens.input + state.totalTokens.output)}
                </span>
              )}
            </button>
            <ToggleSwitch
              label={t('activity:chatView.autoCollapse')}
              value={state.autoCollapseInput}
              onChange={state.handleToggleAutoCollapse}
            />
          </div>
        ) : (
          <>
            {state.messages.length > 0 && (
              <button
                type="button"
                onClick={() => state.setInputCollapsed(true)}
                className="mb-1 flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
              >
                <ChevronDown className="h-3 w-3" />
                <span>{t('chat:input.collapseInput', 'Collapse')}</span>
              </button>
            )}
            <ProviderWaitingRoom />
            <ChatDisplayToggles
              hasStatusContent={state.hasStatusContent}
              totalTokens={state.totalTokens}
              rowsCount={state.rows.length}
              iteration={state.iteration}
              startTime={state.startTime}
              formatDuration={state.formatDuration}
              onToggleAutoCollapse={state.handleToggleAutoCollapse}
            />
            <div className="ws-chat-input-wrap p-0">
              <div className="max-w-6xl mx-auto">
                <ChatInput onOpenBreakdown={() => state.setBreakdownOpen(true)} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Overlays */}
      <Suspense fallback={null}>
        <ProcessMonitor open={state.processOpen} onClose={() => state.setProcessOpen(false)} />
      </Suspense>
      <CheckpointTimeline
        open={state.checkpointOpen}
        onClose={() => state.setCheckpointOpen(false)}
      />
      <ContextBreakdownModal
        open={state.breakdownOpen}
        onClose={() => state.setBreakdownOpen(false)}
      />
      <ToolStatsModal open={state.toolStatsOpen} onClose={() => state.setToolStatsOpen(false)} />
      <ContextWindowEditor open={state.editorOpen} onClose={() => state.setEditorOpen(false)} />
      <MemoryInjectorPanel
        open={state.memoryPanelOpen}
        onClose={() => state.setMemoryPanelOpen(false)}
      />
    </div>
  );
}
