import {
  Activity,
  Box,
  Boxes,
  Brain,
  Columns3,
  FileCode2,
  Folder,
  FolderPlus,
  Gauge,
  GitCompareArrows,
  History,
  LayoutGrid,
  Mail,
  Network,
  Palette,
  Plus,
  ScanSearch,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
  Target,
  Users,
  Workflow,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { isLive } from './model';
import { addProject, native } from './platform';
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
const TOOLS: Array<{ id: ProjectPage; Icon: typeof Brain }> = [
  { id: 'atlas', Icon: Network },
  { id: 'goals', Icon: Target },
  { id: 'sdd', Icon: Workflow },
  { id: 'mailbox', Icon: Mail },
  { id: 'chronicle', Icon: Activity },
  { id: 'roster', Icon: Users },
  { id: 'live-fleet', Icon: Network },
  { id: 'history', Icon: History },
  { id: 'kit', Icon: Box },
  { id: 'techstack', Icon: Boxes },
  { id: 'deadcode', Icon: ScanSearch },
  { id: 'design', Icon: Palette },
  { id: 'reviews', Icon: ShieldCheck },
  { id: 'diagnostics', Icon: Gauge },
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
  const active = TOOLS.some((tool) => tool.id === page);
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
          {TOOLS.map(({ id, Icon }) => (
            <button
              type="button"
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setOpen(false);
                onOpen(id);
              }}
            >
              <Icon size={14} />
              <span>{t(`pages.${id}`)}</span>
            </button>
          ))}
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
          className={`rail-button ${section === 'engine' ? 'active' : ''}`}
          aria-label={t('rail.appearance')}
          title={t('rail.appearance')}
          onClick={() => goTo('engine')}
        >
          <Palette size={17} />
        </button>
        <button
          type="button"
          className={`rail-button ${section === 'wrongstack' ? 'active' : ''}`}
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
            const sessions = snapshot.sessions.filter(
              (s) => s.projectId === p.id && (isLive(s) || vm.openSessionIds.includes(s.id)),
            );
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
                  <button
                    type="button"
                    key={s.id}
                    className={`tree-session ${selected === s.id ? 'chosen' : ''}`}
                    onClick={() => jumpToSession(s)}
                  >
                    <span className={`status-dot ${s.status}`} />
                    <span>{s.title}</span>
                    {s.kind === 'terminal' && <small>{t('explorer.terminal')}</small>}
                  </button>
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
