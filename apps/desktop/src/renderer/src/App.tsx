/**
 * The shell: a sidebar and the area the embedded WebUI covers.
 *
 * The stage is deliberately almost empty. A running project's WebUI is a
 * `WebContentsView` positioned over it by the main process, so anything drawn
 * here is only visible while there is no view to show — before the first
 * project opens, and during the moment a view is loading. Painting status
 * chips, ports and log tails underneath a view that covers them was part of
 * what made the old shell feel busy.
 */
import { useSyncExternalStore } from 'react';
import { Sidebar } from './Sidebar.js';
import { actions, clearError, getSnapshot, subscribe } from './store.js';
import { Icon, useT } from './ui.js';

export function App() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const t = useT();

  return (
    <div className={`shell${state.sidebarCollapsed ? ' is-collapsed' : ''}`}>
      {state.sidebarCollapsed ? <CollapsedRail /> : <Sidebar state={state} />}
      <main className="stage">
        {state.error ? (
          <div className="error-strip" role="alert">
            <span>{state.error}</span>
            <button type="button" className="icon-button" onClick={clearError} title={t('dismiss')}>
              <Icon name="x" />
            </button>
          </div>
        ) : null}
        <Stage state={state} />
      </main>
    </div>
  );
}

function CollapsedRail() {
  const t = useT();
  return (
    <aside className="rail" aria-label={t('projects')}>
      <button
        type="button"
        className="icon-button"
        onClick={() => actions.toggleSidebar()}
        title={t('expand')}
      >
        <span className="brand-mark" aria-hidden="true" />
      </button>
    </aside>
  );
}

function Stage({ state }: { state: ReturnType<typeof getSnapshot> }) {
  const t = useT();
  const activeId = state.desktop.activeRuntimeId;
  const active = state.desktop.runtimes.find((runtime) => runtime.id === activeId);

  if (state.desktop.restoring) {
    return <StageMessage icon="refresh" title={t('restoring')} />;
  }
  if (!active) {
    return (
      <StageMessage
        icon="folder"
        title={t('noProject')}
        hint={t('openProjectHint')}
        action={{ label: t('openProject'), run: () => void actions.openProject() }}
      />
    );
  }
  if (active.status === 'error') {
    return <StageMessage icon="x" title={active.error ?? t('runtimeError')} tone="error" />;
  }
  if (active.status !== 'running' || state.webuiStatus.status === 'loading') {
    return <StageMessage icon="refresh" title={t('starting')} hint={active.name} />;
  }
  // Running and loaded: the WebContentsView is on top of this element.
  return null;
}

function StageMessage({
  icon,
  title,
  hint,
  tone,
  action,
}: {
  icon: 'folder' | 'refresh' | 'x';
  title: string;
  hint?: string | undefined;
  tone?: 'error' | undefined;
  action?: { label: string; run: () => void } | undefined;
}) {
  return (
    <div className={`stage-message${tone ? ` ${tone}` : ''}`}>
      <Icon name={icon} className="stage-icon" />
      <p className="stage-title">{title}</p>
      {hint ? <p className="stage-hint">{hint}</p> : null}
      {action ? (
        <button type="button" className="foot-button primary" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
