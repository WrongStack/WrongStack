import { lazy, Suspense } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import type { EngineCommand } from './engine-operations';
import type { Project, Session } from './model';
import type { RosterRecord } from './roster-model';
import type { DesktopController } from './useDesktop';

const ProjectAgentRoster = lazy(() =>
  import('./ProjectAgentRoster').then((module) => ({ default: module.ProjectAgentRoster })),
);
const ProjectLiveFleet = lazy(() =>
  import('./ProjectLiveFleet').then((module) => ({ default: module.ProjectLiveFleet })),
);

export type AgentWorkspaceTab = 'roster' | 'live';

/**
 * The agent workspace: the project's roster and the live fleet that runs beside it.
 *
 * The WebUI keeps the live fleet inside the agent roster (its roster view opens
 * on the live tab), so the desktop does the same: the roster owns both, and
 * neither is a separate entry in the project's tool menus.
 */
export function ProjectAgentWorkspace({
  project,
  vm,
  command,
  http,
  events,
  nativeSessions,
  carrierId,
  tab,
  onTab,
  onOpenFile,
}: {
  project: Project;
  vm: DesktopController;
  command: EngineCommand;
  http: EngineHttp;
  /** The engine's latest results. */
  events: Record<string, RosterRecord>;
  /** This project's sessions. */
  nativeSessions: Session[];
  /** The engine session that carries this window. */
  carrierId: string;
  /** The tab that is open. */
  tab: AgentWorkspaceTab;
  /** Opens another tab of this workspace. */
  onTab: (tab: AgentWorkspaceTab) => void;
  /** Opens a project file in the files view. */
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  return (
    <section className="project-agent-workspace" aria-label={t('agentWorkspace.label')}>
      <nav className="agent-workspace-tabs" aria-label={t('agentWorkspace.tabsLabel')}>
        <button
          type="button"
          aria-current={tab === 'roster' ? 'page' : undefined}
          onClick={() => onTab('roster')}
        >
          {t('pages.roster')}
        </button>
        <button
          type="button"
          aria-current={tab === 'live' ? 'page' : undefined}
          onClick={() => onTab('live')}
        >
          {t('pages.live-fleet')}
        </button>
      </nav>
      <Suspense
        fallback={
          <p role="status">
            {t('project.openingPage', {
              page: tab === 'live' ? t('pages.live-fleet') : t('pages.roster'),
            })}
          </p>
        }
      >
        {tab === 'live' ? (
          <ProjectLiveFleet
            key={project.id}
            http={http}
            projectRoot={project.root}
            carrierId={carrierId}
            nativeSessions={nativeSessions}
          />
        ) : (
          <ProjectAgentRoster
            key={project.id}
            command={command}
            projectId={project.id}
            projectName={project.name}
            events={events}
            sessions={nativeSessions}
            onPrepare={(id, text) => vm.prepareProjectRequest(project.id, id, text)}
            onNewSession={() => vm.newSession(project.id)}
            onOpenFile={onOpenFile}
          />
        )}
      </Suspense>
    </section>
  );
}
