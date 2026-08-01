import { lazy, Suspense } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { showPanel } from './activity-bar/nav';
import { ChatView } from './ChatView';
import { ContextDashboard } from './ContextDashboard';
import { ErrorBoundary } from './ErrorBoundary';
import { PanelSuspense } from './PanelSuspense';
import { SettingsPanel } from './SettingsPanel';
import { WorkspaceDock } from './WorkspaceDock';
import { useChatStore, useUIStore } from '@/stores';

// Lazy-loaded views
const AnalyticsDashboard = lazy(() =>
  import('./AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const AgentRosterView = lazy(() =>
  import('./AgentRosterView').then((m) => ({ default: m.AgentRosterView })),
);
const ChangesView = lazy(() =>
  import('./ChangesView').then((m) => ({ default: m.ChangesView })),
);
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
const OfficeMapPanel = lazy(() =>
  import('./OfficeMapPanel').then((m) => ({ default: m.OfficeMapPanel })),
);
const RefreshDebugView = lazy(() =>
  import('./RefreshDebugView').then((m) => ({ default: m.RefreshDebugView })),
);
const SageTabs = lazy(() => import('./MemoryManager/SageTabs').then((m) => ({ default: m.SageTabs })));
const SddHub = lazy(() => import('./SddHub').then((m) => ({ default: m.SddHub })));
const SessionsDashboard = lazy(() =>
  import('./SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const SkillDetailView = lazy(() =>
  import('./SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const TechStackView = lazy(() =>
  import('./TechStackView').then((m) => ({ default: m.TechStackView })),
);

/**
 * Main view router — switches the main content area based on `currentView`.
 *
 * Extracted from App.tsx Phase 2 shell decomposition. Each view branch wraps
 * its component in an ErrorBoundary + Suspense. Lazy-loaded views get a
 * PanelSuspense fallback; eagerly-loaded views (chat, settings, context) do not.
 */
export function ViewRouter({ sessionId, desktopShell }: { sessionId: string | null; desktopShell: boolean }): React.ReactElement {
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
      {currentView === 'chat' && (
        <>
          {hasSession && (
            <div className="ws-workspace-dock-wrap shrink-0 px-3 pt-2 sm:px-4">
              <WorkspaceDock />
            </div>
          )}
          <ErrorBoundary level="panel" name="Chat">
            <ChatView />
          </ErrorBoundary>
        </>
      )}
      {currentView === 'settings' && (
        <ErrorBoundary level="panel" name="Settings">
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SettingsPanel />
          </div>
        </ErrorBoundary>
      )}
      {currentView === 'memory' && (
        <ErrorBoundary level="panel" name="SAGE Memory">
          <Suspense fallback={<PanelSuspense label="Loading SAGE…" />}>
            <SageTabs />
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'roster' && (
        <ErrorBoundary level="panel" name="Agent Roster">
          <Suspense fallback={<PanelSuspense label="Loading agent roster…" />}>
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <AgentRosterView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'context' && (
        <ErrorBoundary level="panel" name="Context Dashboard">
          <ContextDashboard />
        </ErrorBoundary>
      )}
      {currentView === 'setup' && (
        <ErrorBoundary level="panel" name="Setup">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SetupScreen />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'goal' && (
        <ErrorBoundary level="panel" name="Goal">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <GoalView onClose={() => showPanel('chat')} />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'sddhub' && (
        <ErrorBoundary level="panel" name="SDD Hub">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SddHub />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'kanban' && (
        <ErrorBoundary level="panel" name="Kanban">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <KanbanView onClose={() => showPanel('chat')} />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'sessions' && (
        <ErrorBoundary level="panel" name="Sessions">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SessionsDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'chronicle' && (
        <ErrorBoundary level="panel" name="Chronicle">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ChronicleDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'debug' && (
        <ErrorBoundary level="panel" name="Debug Dashboard">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <DebugDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'refresh-debug' && (
        <ErrorBoundary level="panel" name="Refresh Debug">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <RefreshDebugView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'files' && (
        <ErrorBoundary level="panel" name="Editor">
          <Suspense fallback={<PanelSuspense label="Loading editor…" />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <CodeEditor />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'changes' && (
        <ErrorBoundary level="panel" name="Changes">
          <Suspense fallback={<PanelSuspense label="Loading diff…" />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ChangesView className="h-full min-h-0" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'mailbox' && (
        <ErrorBoundary level="panel" name="Mailbox">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <MailboxDetailView className="h-full min-h-0" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'design-gallery' && (
        <ErrorBoundary level="panel" name="Design Gallery">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <DesignGalleryView className="h-full" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'skill' && (
        <ErrorBoundary level="panel" name="Skill">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <SkillDetailView className="h-full" />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'officemap' && (
        <ErrorBoundary level="panel" name="Office Map">
          <Suspense fallback={<PanelSuspense label="Loading map…" />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <OfficeMapPanel />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'analytics' && (
        <ErrorBoundary level="panel" name="Analytics">
          <Suspense fallback={<PanelSuspense />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <AnalyticsDashboard />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'codemap' && (
        <ErrorBoundary level="panel" name="CodeMap">
          <Suspense fallback={<PanelSuspense label="Loading CodeMap…" />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <CodeMap />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}
      {currentView === 'techstack' && (
        <ErrorBoundary level="panel" name="TechStack">
          <Suspense fallback={<PanelSuspense label="Loading TechStack…" />}>
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <TechStackView />
            </div>
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Terminal bottom dock */}
      {terminalOpen && (
        <ErrorBoundary level="panel" name="Terminal">
          <Suspense fallback={<PanelSuspense label="Loading terminal…" />}>
            <TerminalPanelLazy desktopShell={desktopShell} onClose={() => setTerminalOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}

// SetupScreen is imported eagerly (it's the first thing users see)
const SetupScreen = lazy(() =>
  import('./SetupScreen').then((m) => ({ default: m.SetupScreen })),
);

const TerminalPanelLazy = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
