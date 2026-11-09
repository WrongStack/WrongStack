import { lazy, Suspense } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import type { EngineTab } from './engine-workspace-tabs';

const SessionMcpTasks = lazy(() =>
  import('./SessionMcpTasks').then((module) => ({ default: module.SessionMcpTasks })),
);
const SessionProcesses = lazy(() =>
  import('./SessionProcesses').then((module) => ({ default: module.SessionProcesses })),
);
const SessionSideEffects = lazy(() =>
  import('./SessionSideEffects').then((module) => ({ default: module.SessionSideEffects })),
);
const SessionPlanTemplates = lazy(() =>
  import('./SessionPlanTemplates').then((module) => ({ default: module.SessionPlanTemplates })),
);
const SessionUsage = lazy(() =>
  import('./SessionUsage').then((module) => ({ default: module.SessionUsage })),
);
const SessionStory = lazy(() =>
  import('./SessionStory').then((module) => ({ default: module.SessionStory })),
);
const SessionContextDashboard = lazy(() =>
  import('./SessionContextDashboard').then((module) => ({
    default: module.SessionContextDashboard,
  })),
);
export function EngineSessionPanels({
  tab,
  state,
  sessionTitle,
  projectId,
  projectRoot,
  send,
  command,
  onBack,
}: {
  tab: EngineTab;
  state: EngineState;
  sessionTitle: string;
  projectId: string;
  projectRoot: string;
  send: EngineSend;
  command: EngineCommand;
  onBack: () => void;
}) {
  const { t } = useDesktopText();
  return tab === 'side-effects' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.sideEffects')}</p>}>
      <SessionSideEffects
        key={state.sessionId}
        sessionId={state.sessionId}
        connected={state.connected}
        command={command}
        onBack={onBack}
      />
    </Suspense>
  ) : tab === 'plan' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.planTemplates')}</p>}>
      <SessionPlanTemplates
        key={state.sessionId}
        command={command}
        running={state.running}
        onBack={onBack}
      />
    </Suspense>
  ) : tab === 'usage' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.usage')}</p>}>
      <SessionUsage
        key={state.sessionId}
        sessionId={state.sessionId}
        sessionTitle={sessionTitle}
        connected={state.connected}
        command={command}
        onBack={onBack}
        delegations={state.delegations}
        toolActivity={state}
      />
    </Suspense>
  ) : tab === 'story' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.story')}</p>}>
      <SessionStory
        key={state.sessionId}
        projectId={projectId}
        projectRoot={projectRoot}
        state={state}
        send={send}
        command={command}
        onBack={onBack}
      />
    </Suspense>
  ) : tab === 'context' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.context')}</p>}>
      <SessionContextDashboard
        key={state.sessionId}
        projectId={projectId}
        projectRoot={projectRoot}
        state={state}
        command={command}
        onBack={onBack}
      />
    </Suspense>
  ) : tab === 'processes' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.processes')}</p>}>
      <SessionProcesses
        key={state.sessionId}
        sessionId={state.sessionId}
        connected={state.connected}
        command={command}
        onBack={onBack}
      />
    </Suspense>
  ) : tab === 'mcp-tasks' ? (
    <Suspense fallback={<p role="status">{t('chatView.opening.mcpTasks')}</p>}>
      <SessionMcpTasks
        key={state.sessionId}
        sessionId={state.sessionId}
        connected={state.connected}
        command={command}
        pendingReviews={state.approvals.length + state.inputs.length}
        onBack={onBack}
      />
    </Suspense>
  ) : null;
}

export function isEngineSessionPanel(
  tab: EngineTab,
): tab is 'side-effects' | 'plan' | 'usage' | 'story' | 'context' | 'processes' | 'mcp-tasks' {
  return ['side-effects', 'plan', 'usage', 'story', 'context', 'processes', 'mcp-tasks'].includes(
    tab,
  );
}
