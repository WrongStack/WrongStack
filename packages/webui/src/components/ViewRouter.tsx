import { lazy, Suspense } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores';
import { showPanel } from './activity-bar/nav';
import { ChatView } from './ChatView';
import { AgentTabs } from './ChatView/AgentTabs';
import { ContextDashboard } from './ContextDashboard';
import { ErrorBoundary } from './ErrorBoundary';
import { PanelSuspense } from './PanelSuspense';
import { SettingsPanel } from './SettingsPanel';
import { WorkspaceDock } from './WorkspaceDock';

// Lazy-loaded views
const AnalyticsDashboard = lazy(() =>
  import('./AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const AgentRosterView = lazy(() =>
  import('./AgentRosterView').then((m) => ({ default: m.AgentRosterView })),
);
const ChangesView = lazy(() => import('./ChangesView').then((m) => ({ default: m.ChangesView })));
const ChronicleDashboard = lazy(() =>
  import('./ChronicleDashboard').then((m) => ({ default: m.ChronicleDashboard })),
);
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
const CodeMap = lazy(() => import('./CodeMap').then((m) => ({ default: m.CodeMap })));
const DebugDashboard = lazy(() =>
  import('./DebugDashboard').then((m) => ({ default: m.DebugDashboard })),
);
const DesignGalleryView = lazy(() =>
  import('./DesignGalleryView').then((m) => ({ default: m.DesignGalleryView })),
);
const GoalView = lazy(() => import('./GoalView').then((m) => ({ default: m.GoalView })));
const KanbanView = lazy(() => import('./KanbanView').then((m) => ({ default: m.KanbanView })));
const MailboxDetailView = lazy(() =>
  import('./MailboxDetailView').then((m) => ({ default: m.MailboxDetailView })),
);
const PromptJournalView = lazy(() =>
  import('./PromptJournalView').then((m) => ({ default: m.PromptJournalView })),
);
const RefreshDebugView = lazy(() =>
  import('./RefreshDebugView').then((m) => ({ default: m.RefreshDebugView })),
);
const SageTabs = lazy(() =>
  import('./MemoryManager/SageTabs').then((m) => ({ default: m.SageTabs })),
);
const RequirementIntakeView = lazy(() =>
  import('./RequirementIntakeView').then((m) => ({ default: m.RequirementIntakeView })),
);
const SddHub = lazy(() => import('./SddHub').then((m) => ({ default: m.SddHub })));
const SessionsDashboard = lazy(() =>
  import('./SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const SessionInspectView = lazy(() =>
  import('./SessionInspectView').then((m) => ({ default: m.SessionInspectView })),
);
const SkillDetailView = lazy(() =>
  import('./SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const TechStackView = lazy(() =>
  import('./TechStackView').then((m) => ({ default: m.TechStackView })),
);
const DeadCodeScanPanel = lazy(() =>
  import('./DeadCodeScanPanel/DeadCodeScanPanel').then((m) => ({ default: m.DeadCodeScanPanel })),
);

/**
 * Main view router — switches the main content area based on `currentView`.
 *
 * Extracted from App.tsx Phase 2 shell decomposition. Each view branch wraps
 * its component in an ErrorBoundary + Suspense. Lazy-loaded views get a
 * PanelSuspense fallback; eagerly-loaded views (chat, settings, context) do not.
 */
export function ViewRouter({
  sessionId,
  desktopShell,
}: {
  sessionId: string | null;
  desktopShell: boolean;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const { currentView, terminalOpen, setTerminalOpen } = useUIStore(
    useShallow((s) => ({
      currentView: s.currentView,
      terminalOpen: s.terminalOpen,
      setTerminalOpen: s.setTerminalOpen,
    })),
  );

  const hasSession = sessionId;

  return (
    <>
      {/* Dock strip and the AGENTS switcher belong to the chat surface. They
          stay MOUNTED for the session lifetime — their store subscriptions and
          internal state keep running — but render only over chat: parked
          (out of flow, inert) while another view is in front, exactly like
          the transcript below. */}
      {hasSession && (
        <div
          className={cn('flex flex-col', currentView !== 'chat' && 'ws-view-parked')}
          {...(currentView !== 'chat' ? { inert: true, 'aria-hidden': true } : {})}
        >
          <div className="ws-workspace-dock-wrap shrink-0 px-3 pt-2 sm:px-4">
            <WorkspaceDock />
          </div>
          <AgentTabs />
        </div>
      )}

      {/* Chat is MOUNTED FOR THE LIFETIME OF THE SESSION and parked when
          another view is in front — never unmounted. It owns a virtualized
          transcript, a scroll position, an unsent composer draft and the live
          stream target; tearing all of that down on every trip to Files or
          Kanban is what made coming back to chat re-render from scratch. */}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          currentView !== 'chat' && 'ws-view-parked',
        )}
        {...(currentView !== 'chat' ? { inert: true, 'aria-hidden': true } : {})}
      >
        <ErrorBoundary level="panel" name={t('activity:panels.chat')}>
          <ChatView />
        </ErrorBoundary>
      </div>
      {currentView === 'settings' && (
        <ErrorBoundary level="panel" name={t('activity:panels.settings')}>
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SettingsPanel />
          </div>
        </ErrorBoundary>
      )}
      {currentView === 'memory' && (
        <ErrorBoundary level="panel" name={t('activity:panels.sageMemory')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.sageMemory') })}
              />
            }
          >
            {/* Vector memory lives inside SageTabs as its third lens —
                strictly opt-in; the panel renders a "disabled" placeholder
                when the host doesn't wire a vector store. */}
            <SageTabs />
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'roster' && (
        <ErrorBoundary level="panel" name={t('activity:panels.agentRoster')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.agentRoster') })}
              />
            }
          >
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <AgentRosterView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'context' && (
        <ErrorBoundary level="panel" name={t('activity:panels.contextDashboard')}>
          <ContextDashboard />
        </ErrorBoundary>
      )}
      {currentView === 'setup' && (
        <ErrorBoundary level="panel" name={t('activity:panels.setup')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SetupScreen />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'goal' && (
        <ErrorBoundary level="panel" name={t('activity:panels.goal')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <GoalView onClose={() => showPanel('chat')} />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'sddhub' && (
        <ErrorBoundary level="panel" name={t('activity:panels.sddHub')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SddHub />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'kanban' && (
        <ErrorBoundary level="panel" name={t('activity:panels.kanban')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <KanbanView onClose={() => showPanel('chat')} />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'sessions' && (
        <ErrorBoundary level="panel" name={t('activity:panels.sessions')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SessionsDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'session-inspect' && (
        <ErrorBoundary level="panel" name={t('activity:panels.sessionInspect')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.sessionInspect') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SessionInspectView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'chronicle' && (
        <ErrorBoundary level="panel" name={t('activity:panels.chronicle')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ChronicleDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'intake' && (
        <ErrorBoundary level="panel" name={t('activity:panels.requirementsIntake')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <RequirementIntakeView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'prompts' && (
        <ErrorBoundary level="panel" name={t('activity:nav.prompts')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:nav.prompts') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <PromptJournalView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'debug' && (
        <ErrorBoundary level="panel" name={t('activity:panels.debugDashboard')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <DebugDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'refresh-debug' && (
        <ErrorBoundary level="panel" name={t('activity:panels.refreshDebug')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <RefreshDebugView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'files' && (
        <ErrorBoundary level="panel" name={t('activity:panels.editor')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.editor') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <CodeEditor />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'changes' && (
        <ErrorBoundary level="panel" name={t('activity:panels.changes')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.changes') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ChangesView className="h-full min-h-0" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'mailbox' && (
        <ErrorBoundary level="panel" name={t('activity:panels.mailbox')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <MailboxDetailView className="h-full min-h-0" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'design-gallery' && (
        <ErrorBoundary level="panel" name={t('activity:panels.designGallery')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <DesignGalleryView className="h-full" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'skill' && (
        <ErrorBoundary level="panel" name={t('activity:panels.skill')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SkillDetailView className="h-full" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'analytics' && (
        <ErrorBoundary level="panel" name={t('activity:panels.analytics')}>
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <AnalyticsDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'codemap' && (
        <ErrorBoundary level="panel" name={t('activity:panels.codemap')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.codemap') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <CodeMap />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'techstack' && (
        <ErrorBoundary level="panel" name={t('activity:panels.techstack')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.techstack') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <TechStackView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'deadcode' && (
        <ErrorBoundary level="panel" name={t('activity:panels.deadcode')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.deadcode') })}
              />
            }
          >
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
              <DeadCodeScanPanel />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Terminal bottom dock */}
      {terminalOpen && (
        <ErrorBoundary level="panel" name={t('activity:panels.terminal')}>
          <Suspense
            fallback={
              <PanelSuspense
                label={t('common:loadingNamed', { name: t('activity:panels.terminal') })}
              />
            }
          >
            <TerminalPanelLazy desktopShell={desktopShell} onClose={() => setTerminalOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}

// SetupScreen is imported eagerly (it's the first thing users see)
const SetupScreen = lazy(() => import('./SetupScreen').then((m) => ({ default: m.SetupScreen })));

const TerminalPanelLazy = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
