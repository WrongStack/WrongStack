import { ArrowRight, BookOpen, Brain, Network, Settings, Terminal, Workflow } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { projectHttp } from './engine-http';
import { entries, record } from './engine-values';
import { FileWorkspace } from './FileWorkspace';
import { MailboxUnread } from './MailboxUnread';
import { isLive, type Project } from './model';
import { ProjectAgentWorkspace } from './ProjectAgentWorkspace';
import { ProjectAnalytics } from './ProjectAnalytics';
import { ProjectAtlas } from './ProjectAtlas';
import { ProjectBreadcrumb } from './ProjectBreadcrumb';
import { ProjectChronicle } from './ProjectChronicle';
import { ProjectDiagnostics } from './ProjectDiagnostics';
import { ProjectGoals } from './ProjectGoals';
import { type KanbanFocus, ProjectKanban } from './ProjectKanban';
import { ProjectMailbox } from './ProjectMailbox';
import { ProjectOffice } from './ProjectOffice';
import { ProjectSage } from './ProjectSage';
import { ProjectSdd } from './ProjectSdd';
import { ProjectToolsMenu } from './ProjectToolsMenu';
import { ProjectWorktrees } from './ProjectWorktrees';
import { PromptWorkspace } from './PromptWorkspace';
import {
  projectFormDraftStorage,
  requirementDraftStorage,
  requirementRecordDraftStorage,
} from './platform';
import { RuntimeGate } from './RuntimeGate';
import { SkillLibrary } from './SkillLibrary';
import type { DesktopController } from './useDesktop';
import { useProjectEngine } from './useEngine';

const AutomationWorkspace = lazy(() =>
  import('./AutomationWorkspace').then((module) => ({ default: module.AutomationWorkspace })),
);
const ProjectKit = lazy(() =>
  import('./ProjectKit').then((module) => ({ default: module.ProjectKit })),
);
const ProjectDeadCode = lazy(() =>
  import('./ProjectDeadCode').then((module) => ({ default: module.ProjectDeadCode })),
);
const ProjectDesignStudio = lazy(() =>
  import('./ProjectDesignStudio').then((module) => ({ default: module.ProjectDesignStudio })),
);
const ProjectChimera = lazy(() =>
  import('./ProjectChimera').then((module) => ({ default: module.ProjectChimera })),
);
const ProjectSessionHistory = lazy(() =>
  import('./ProjectSessionHistory').then((module) => ({ default: module.ProjectSessionHistory })),
);
const ProjectTechStack = lazy(() =>
  import('./ProjectTechStack').then((module) => ({ default: module.ProjectTechStack })),
);

export function ProjectWorkspace({ project, vm }: { project: Project; vm: DesktopController }) {
  const { t } = useDesktopText();
  const [promptsOpen, setPromptsOpen] = useState(false);
  return (
    <div className="project-workspace">
      <div className="project-context-bar">
        <ProjectBreadcrumb project={project} vm={vm} />
        <button
          type="button"
          className="button secondary small"
          onClick={() => setPromptsOpen(true)}
        >
          <BookOpen size={13} /> {t('composer.library')}
        </button>
      </div>
      <RuntimeGate scope="project" projectId={project.id}>
        <ProjectContent project={project} vm={vm} />
      </RuntimeGate>
      {promptsOpen && (
        <PromptWorkspace
          key={project.id}
          projectId={project.id}
          sessionId=""
          kind="library"
          onClose={() => setPromptsOpen(false)}
        />
      )}
    </div>
  );
}
function ProjectContent({ project, vm }: { project: Project; vm: DesktopController }) {
  const { state, send, command } = useProjectEngine(project.id, vm.reportError);
  const { t } = useDesktopText();
  const projectSessions = vm.snapshot.sessions.filter((item) => item.projectId === project.id);
  const http = useMemo(() => projectHttp(project.id), [project.id]);
  const requirementDrafts = useMemo(() => requirementDraftStorage(project.id), [project.id]);
  const resourceInputStorage = useCallback(
    (formKey: string) => projectFormDraftStorage(project.id, formKey),
    [project.id],
  );
  const recordDraftStorage = useCallback(
    (id: string) => requirementRecordDraftStorage(project.id, id),
    [project.id],
  );
  // A line, when known, opens the file scrolled to and marking that source line.
  const [fileTarget, setFileTargetState] = useState({ path: '', line: 0, endLine: 0 }),
    [memoryTarget, setMemoryTarget] = useState('');
  // Cross-links between run mirror boards and the Goal/SDD views that own the runs.
  const [kanbanFocus, setKanbanFocus] = useState<KanbanFocus | null>(null),
    [goalTarget, setGoalTarget] = useState(''),
    [historyTarget, setHistoryTarget] = useState('');
  // A history focus applies to the visit it was made for.
  useEffect(() => {
    if (vm.projectPage !== 'history') setHistoryTarget('');
  }, [vm.projectPage]);
  const setFileTarget = (path: string, line = 0, endLine = 0) =>
    setFileTargetState({ path, line, endLine });
  useEffect(() => {
    if (vm.projectPage !== 'files' && vm.projectPage !== 'changes') setFileTarget('');
  }, [vm.projectPage]);
  if (!state.connected)
    return (
      <div className="runtime-state">
        <h2>{t('project.opening', { name: project.name })}</h2>
        <p>{t('project.gettingReady')}</p>
      </div>
    );
  return (
    <div className="project-page-content">
      {vm.projectPage === 'files' || vm.projectPage === 'changes' ? (
        <FileWorkspace
          command={command}
          send={send}
          state={state}
          scopeKey={project.root}
          projectId={project.id}
          mode={vm.projectPage}
          initialPath={fileTarget.path}
          {...(fileTarget.line ? { initialLine: fileTarget.line } : {})}
          {...(fileTarget.endLine ? { initialEndLine: fileTarget.endLine } : {})}
        />
      ) : vm.projectPage === 'chronicle' ? (
        <ProjectChronicle
          command={command}
          onOpenFile={(path) => {
            setFileTarget(path);
            vm.setProjectPage('files');
          }}
          onOpenSession={(sessionId) => {
            setHistoryTarget(sessionId);
            vm.setProjectPage('history');
          }}
        />
      ) : vm.projectPage === 'mailbox' ? (
        <ProjectMailbox key={project.id} command={command} projectId={project.id} state={state} />
      ) : vm.projectPage === 'worktrees' ? (
        <ProjectWorktrees key={project.id} state={state} send={send} />
      ) : vm.projectPage === 'office' ? (
        <ProjectOffice project={project} sessions={projectSessions} http={http} />
      ) : vm.projectPage === 'diagnostics' ? (
        <ProjectDiagnostics projectId={project.id} http={http} sessions={projectSessions} />
      ) : vm.projectPage === 'analytics' ? (
        <ProjectAnalytics projectId={project.id} http={http} />
      ) : vm.projectPage === 'roster' || vm.projectPage === 'live-fleet' ? (
        <ProjectAgentWorkspace
          project={project}
          vm={vm}
          command={command}
          http={http}
          events={state.results}
          nativeSessions={projectSessions}
          carrierId={state.sessionId}
          tab={vm.projectPage === 'live-fleet' ? 'live' : 'roster'}
          onTab={(tab) => vm.setProjectPage(tab === 'live' ? 'live-fleet' : 'roster')}
          onOpenFile={(path) => {
            setFileTarget(path);
            vm.setProjectPage('files');
          }}
        />
      ) : vm.projectPage === 'techstack' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.techstack') })}</p>}
        >
          <ProjectTechStack
            key={project.id}
            http={http}
            projectId={project.id}
            events={state.results}
            onOpenFile={(path) => {
              setFileTarget(path);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'deadcode' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.deadcode') })}</p>}
        >
          <ProjectDeadCode
            key={project.id}
            http={http}
            projectId={project.id}
            sessions={projectSessions}
            onPrepare={(id, text) => vm.prepareProjectRequest(project.id, id, text)}
            onNewSession={() => vm.newSession(project.id)}
            onOpenFile={(path, line, endLine) => {
              setFileTarget(path, line, endLine);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'design' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.design') })}</p>}
        >
          <ProjectDesignStudio
            key={project.id}
            projectId={project.id}
            command={command}
            onOpenFile={(path) => {
              setFileTarget(path);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'history' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.history') })}</p>}
        >
          <ProjectSessionHistory
            key={`${project.id}:${historyTarget}`}
            focusSessionId={historyTarget}
            projectId={project.id}
            carrierId={state.sessionId}
            command={command}
            sessions={projectSessions}
            onOpen={vm.jumpToSession}
            onPrepare={(id, text) => vm.prepareProjectRequest(project.id, id, text)}
            onNewSession={() => vm.newSession(project.id)}
            onOpenFile={(path) => {
              setFileTarget(path);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'reviews' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.reviews') })}</p>}
        >
          <ProjectChimera
            key={project.id}
            command={command}
            projectId={project.id}
            events={state.results}
            sessions={projectSessions}
            onPrepare={(id, text) => vm.prepareProjectRequest(project.id, id, text)}
            onNewSession={() => vm.newSession(project.id)}
            onOpenFile={(path, line) => {
              setFileTarget(path, line);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'kit' ? (
        <Suspense
          fallback={<p role="status">{t('project.openingPage', { page: t('pages.kit') })}</p>}
        >
          <ProjectKit
            key={project.id}
            projectId={project.id}
            http={http}
            sessions={projectSessions}
            onPrepare={(id, text) => vm.prepareProjectRequest(project.id, id, text)}
            onNewSession={() => vm.newSession(project.id)}
            onOpenFile={(path) => {
              setFileTarget(path);
              vm.setProjectPage('files');
            }}
          />
        </Suspense>
      ) : vm.projectPage === 'skills' ? (
        <SkillLibrary
          command={command}
          scope="project"
          projectId={project.id}
          onOpenFile={(path) => {
            setFileTarget(path);
            vm.setProjectPage('files');
          }}
        />
      ) : vm.projectPage === 'memory' ? (
        <ProjectSage projectId={project.id} http={http} initialMemoryId={memoryTarget} />
      ) : vm.projectPage === 'kanban' ? (
        <ProjectKanban
          projectId={project.id}
          http={http}
          command={command}
          focus={kanbanFocus}
          onOpenSource={(source) => {
            if (source.system === 'goal') setGoalTarget(source.runId);
            vm.setProjectPage(source.system === 'goal' ? 'goals' : 'sdd');
          }}
        />
      ) : vm.projectPage === 'goals' ? (
        <ProjectGoals
          state={state}
          send={send}
          initialGoalId={goalTarget}
          onKanban={(focus) => {
            setKanbanFocus(focus ? { ...focus, nonce: Date.now() } : null);
            vm.setProjectPage('kanban');
          }}
        />
      ) : vm.projectPage === 'sdd' ? (
        <ProjectSdd
          state={state}
          send={send}
          command={command}
          http={http}
          draftStorage={requirementDrafts}
          recordDraftStorage={recordDraftStorage}
          resourceInputStorage={resourceInputStorage}
          onKanban={(focus) => {
            setKanbanFocus({ ...focus, nonce: Date.now() });
            vm.setProjectPage('kanban');
          }}
        />
      ) : vm.projectPage === 'atlas' ? (
        <ProjectAtlas
          projectId={project.id}
          projectRoot={project.root}
          http={http}
          send={send}
          state={state}
          command={command}
          onOpenFile={(path) => {
            setFileTarget(path);
            vm.setProjectPage('files');
          }}
          onOpenMemory={(id) => {
            setMemoryTarget(id);
            vm.setProjectPage('memory');
          }}
        />
      ) : vm.projectPage === 'automations' ? (
        <section className="project-automations">
          <header className="studio-heading">
            <div>
              <h1>{t('pages.automations')}</h1>
              <p>{t('project.automations', { name: project.name })}</p>
            </div>
          </header>
          <Suspense
            fallback={
              <p role="status">{t('project.openingPage', { page: t('pages.automations') })}</p>
            }
          >
            <AutomationWorkspace key={project.id} projectId={project.id} http={http} />
          </Suspense>
        </section>
      ) : (
        <ProjectOverview
          project={project}
          vm={vm}
          command={command}
          http={http}
          mailboxActivity={state.results['mailbox.event']}
        />
      )}
    </div>
  );
}
function ProjectOverview({
  project,
  vm,
  command,
  http,
  mailboxActivity,
}: {
  project: Project;
  vm: DesktopController;
  command: ReturnType<typeof useProjectEngine>['command'];
  http: ReturnType<typeof projectHttp>;
  /** The latest mailbox event; a change re-reads the unread count. */
  mailboxActivity: unknown;
}) {
  const { t } = useDesktopText();
  const [memories, setMemories] = useState<number | null>(null),
    [boards, setBoards] = useState<Record<string, unknown>[]>([]),
    [packages, setPackages] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      command('memory.sage.listPage', { statuses: ['active'], limit: 1 }, [
        'memory.sage.listPage',
      ]).then((data) => {
        if (current) setMemories(Number(data['total'] ?? entries(data['memories']).length));
      }),
      command('kanban.list', {}, ['kanban.list']).then((data) => {
        if (current)
          setBoards(
            entries(data['data']).filter(
              (board) => board['kind'] !== 'session_mirror' && board['kind'] !== 'archive',
            ),
          );
      }),
      http('/api/codemap/packages').then((data) => {
        if (current) setPackages(entries(record(data)['nodes']).length);
      }),
    ]);
    return () => {
      current = false;
    };
  }, [command, http]);
  const sessions = vm.snapshot.sessions.filter((session) => session.projectId === project.id);
  const tasks = boards.reduce((sum, board) => sum + Number(board['taskCount'] ?? 0), 0);
  return (
    <section className="project-overview">
      <div className="project-destination-grid">
        <button
          type="button"
          className="project-destination destination-memory"
          onClick={() => vm.setProjectPage('memory')}
        >
          <div className="destination-art memory-art" aria-hidden="true">
            <svg viewBox="0 0 360 150">
              <title>{t('overview.memory.art')}</title>
              <path d="M54 86L126 40L196 82L285 38M126 40L155 125L196 82L301 119M54 86L155 125" />
              <circle cx="54" cy="86" r="15" />
              <circle cx="126" cy="40" r="21" />
              <circle cx="196" cy="82" r="28" />
              <circle cx="155" cy="125" r="12" />
              <circle cx="285" cy="38" r="12" />
              <circle cx="301" cy="119" r="17" />
            </svg>
            <Brain size={24} />
          </div>
          <div className="destination-copy">
            <h2>
              {t('pages.memory')}
              <ArrowRight size={18} />
            </h2>
            <p>{t('overview.memory.body')}</p>
            <strong>
              {memories === null
                ? t('overview.memory.loading')
                : t('overview.memory.count', { count: memories })}
            </strong>
          </div>
        </button>
        <button
          type="button"
          className="project-destination destination-kanban"
          onClick={() => vm.setProjectPage('kanban')}
        >
          <div className="destination-art board-art" aria-hidden="true">
            {[3, 2, 2].map((count, index) => (
              <div key={index} className="board-art-column">
                <i className="board-art-line" />
                {Array.from({ length: count }, (_, card) => (
                  <span key={card}>
                    <b />
                    <b />
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="destination-copy">
            <h2>
              {t('pages.kanban')}
              <ArrowRight size={18} />
            </h2>
            <p>{t('overview.kanban.body')}</p>
            <strong>{t('overview.kanban.count', { tasks, boards: boards.length })}</strong>
          </div>
        </button>
        <button
          type="button"
          className="project-destination destination-atlas"
          onClick={() => vm.setProjectPage('atlas')}
        >
          <div className="destination-art atlas-art" aria-hidden="true">
            <svg viewBox="0 0 360 150">
              <title>{t('overview.atlas.art')}</title>
              <path d="M68 55L180 34L292 60M68 55L84 116L180 98L292 60L270 129M180 34L180 98L270 129" />
              {[
                [68, 55],
                [180, 34],
                [292, 60],
                [84, 116],
                [180, 98],
                [270, 129],
              ].map(([x, y], index) => (
                <rect x={x! - 12} y={y! - 10} width={24} height={20} rx={4} key={index} />
              ))}
            </svg>
            <Network size={25} />
          </div>
          <div className="destination-copy">
            <h2>
              {t('pages.atlas')}
              <ArrowRight size={18} />
            </h2>
            <p>{t('overview.atlas.body')}</p>
            <strong>
              {packages === null
                ? t('overview.atlas.ready')
                : t('overview.atlas.count', { count: packages })}
            </strong>
          </div>
        </button>
      </div>
      <ProjectToolsMenu
        page={vm.projectPage}
        onOpen={(id) => vm.setProjectPage(id)}
        variant="overview"
        badges={{
          mailbox: <MailboxUnread command={command} trigger={mailboxActivity} />,
        }}
        after={
          <section className="project-tools-group">
            <div className="project-tools-items">
              <button
                type="button"
                className="project-tool"
                onClick={() => vm.openWrongStackSettings()}
              >
                <Settings size={21} />
                <div className="project-tool-copy">
                  <strong>{t('rail.settings')}</strong>
                  <span>{t('overview.links.settings')}</span>
                </div>
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        }
      />
      <section className="project-session-summary">
        <header>
          <div>
            <h2>{t('overview.sessions.title')}</h2>
            <p>{t('overview.sessions.active', { count: sessions.filter(isLive).length })}</p>
          </div>
          <button
            type="button"
            className="button secondary small"
            onClick={() => vm.newSession(project.id, 'terminal')}
          >
            <Terminal size={13} />
            {t('overview.sessions.terminal')}
          </button>
        </header>
        {sessions.length ? (
          <div className="project-session-rows">
            {sessions.slice(0, 8).map((session) => (
              <button type="button" key={session.id} onClick={() => vm.jumpToSession(session)}>
                <span className={`status-dot ${session.status}`} />
                {session.kind === 'terminal' ? <Terminal size={15} /> : <Workflow size={15} />}
                <strong>{session.title}</strong>
                <span>{t(`status.${session.status}`, { defaultValue: session.status })}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="project-no-sessions">
            <Workflow size={20} />
            <span>{t('overview.sessions.empty')}</span>
            <button type="button" onClick={() => vm.newSession(project.id)}>
              {t('overview.sessions.start')}
              <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
