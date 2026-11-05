import {
  Activity,
  Brain,
  Columns3,
  FileCode2,
  Folder,
  FolderPlus,
  Gauge,
  GitCompareArrows,
  LayoutGrid,
  Palette,
  Plus,
  Search,
  Settings,
  Shapes,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { ProjectToolsMenu } from './ProjectToolsMenu';
import { addProject, native } from './platform';
import { owningTool, projectTools } from './project-tools';
import { SidebarSessionRow } from './SidebarSessionRow';
import { sidebarSessions } from './session-layout';
import { requestSettingsSection, useShownSettingsSection } from './settings-section-request';
import type { DesktopController, ProjectPage } from './useDesktop';

/**
 * WebUI's calm layout: a narrow icon rail with a few pinned views and a Tools launcher for the
 * rest, beside one list of projects and their sessions. Every view stays one click away; none of
 * them competes for space with the conversation.
 */
const PINNED: Array<{ id: ProjectPage; Icon: typeof Brain }> = [
  { id: 'files', Icon: FileCode2 },
  { id: 'changes', Icon: GitCompareArrows },
  { id: 'memory', Icon: Brain },
  { id: 'kanban', Icon: Columns3 },
];

function ToolsLauncher({
  page,
  onOpen,
}: {
  page: ProjectPage | undefined;
  onOpen: (page: ProjectPage) => void;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const active = projectTools.some((tool) => tool.id === owningTool(page));
  return (
    <div className="rail-tools" ref={root}>
      <button
        type="button"
        className={`rail-button ${active ? 'active' : ''}`}
        title={t('rail.projectTools')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Shapes size={17} />
        <span>{t('rail.projectTools')}</span>
      </button>
      {open && (
        <div className="rail-popover">
          <ProjectToolsMenu
            page={owningTool(page)}
            onOpen={(id) => {
              setOpen(false);
              onOpen(id);
            }}
            variant="launcher"
          />
        </div>
      )}
    </div>
  );
}

export function Sidebar({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  const {
    snapshot,
    project,
    setProject,
    selected,
    setSelected,
    section,
    setSection,
    setSearch,
    setDialog,
    pending,
    run,
    jumpToSession,
    currentProject,
  } = vm;
  const page = section === 'project' ? vm.projectPage : undefined;
  const shownSettings = useShownSettingsSection();
  const quotaShown = section === 'wrongstack' && shownSettings === 'quota';
  const goTo = (id: 'fleet' | 'projects' | 'activity' | 'engine' | 'wrongstack') => {
    if (id === 'wrongstack') vm.openWrongStackSettings();
    setSection(id);
    setProject(null);
    setSelected(null);
  };
  const main = (
    id: 'fleet' | 'projects' | 'activity',
    label: string,
    Icon: typeof Brain,
    count?: number,
  ) => (
    <button
      type="button"
      className={`rail-button ${section === id && !project ? 'active' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => goTo(id)}
    >
      <Icon size={17} />
      {count ? <span className="rail-count">{count}</span> : null}
    </button>
  );
  return (
    <aside className="sidebar">
      <nav className="rail" aria-label={t('rail.navigation')}>
        <button
          type="button"
          className="rail-brand"
          aria-label={t('rail.home')}
          title="WrongStack"
          onClick={() => goTo('fleet')}
        >
          <span className="brand-mark">
            <img src="/wrongstack-mark.svg" alt="" width="28" height="14" />
          </span>
        </button>
        {main('fleet', t('rail.missionControl'), LayoutGrid, vm.active.length)}
        {main('projects', t('rail.projects'), Folder)}
        {main('activity', t('rail.activity'), Activity)}
        <div className="rail-spacer" />
        <button
          type="button"
          className={`rail-button ${quotaShown ? 'active' : ''}`}
          aria-label={t('rail.quota')}
          title={t('rail.quota')}
          onClick={() => {
            requestSettingsSection('quota');
            goTo('wrongstack');
          }}
        >
          <Gauge size={17} />
        </button>
        <button
          type="button"
          className={`rail-button ${section === 'engine' ? 'active' : ''}`}
          aria-label={t('rail.appearance')}
          title={t('rail.appearance')}
          onClick={() => goTo('engine')}
        >
          <Palette size={17} />
        </button>
        <button
          type="button"
          className={`rail-button ${section === 'wrongstack' && !quotaShown ? 'active' : ''}`}
          aria-label={t('rail.settings')}
          title={t('rail.settings')}
          onClick={() => goTo('wrongstack')}
        >
          <Settings size={17} />
        </button>
      </nav>
      <div className="explorer">
        <button
          type="button"
          className="quick-search"
          onClick={() => {
            setSearch('');
            setDialog('palette');
          }}
        >
          <Search size={14} />
          <span>{t('explorer.findAnything')}</span>
          <kbd>Ctrl K</kbd>
        </button>
        {currentProject && (
          <nav
            className="project-views"
            aria-label={t('explorer.workspace', { name: currentProject.name })}
          >
            {PINNED.map(({ id, Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => vm.openProjectPage(currentProject.id, id)}
              >
                <Icon size={15} />
                <span>{t(`pages.${id}`)}</span>
              </button>
            ))}
            <ToolsLauncher page={page} onOpen={(id) => vm.openProjectPage(currentProject.id, id)} />
          </nav>
        )}
        <div className="explorer-caption">
          <span>{t('explorer.projects')}</span>
          <button
            type="button"
            aria-label={t('explorer.addProject')}
            title={t('explorer.addProject')}
            disabled={!native || pending}
            onClick={() => void run(addProject)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="project-tree">
          {snapshot.projects.map((p, i) => {
            const sessions = sidebarSessions(snapshot.sessions, p.id, vm.openSessionIds);
            return (
              <div key={p.id} className="project-branch">
                <div className="project-branch-heading">
                  <button
                    type="button"
                    className={`project-item ${project === p.id ? 'selected' : ''}`}
                    onClick={() => vm.openProjectPage(p.id)}
                  >
                    <span className={`project-symbol color-${i % 4}`}>
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{p.name}</span>
                  </button>
                  <button
                    type="button"
                    className="project-new-session"
                    aria-label={t('explorer.newSessionIn', { name: p.name })}
                    title={t('explorer.newSession')}
                    disabled={!native || pending}
                    onClick={() => vm.newSession(p.id)}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {sessions.map((s) => (
                  <SidebarSessionRow
                    key={s.id}
                    session={s}
                    chosen={selected === s.id}
                    disabled={!native || pending}
                    onOpen={jumpToSession}
                    run={run}
                    onRemoved={vm.closeSessionTab}
                  />
                ))}
              </div>
            );
          })}
          {!snapshot.projects.length && <p className="sidebar-empty">{t('explorer.empty')}</p>}
          <button
            type="button"
            className="add-project"
            disabled={!native || pending}
            onClick={() => void run(addProject)}
          >
            <FolderPlus size={14} /> {t('explorer.addProject')}
          </button>
        </div>
      </div>
    </aside>
  );
}
