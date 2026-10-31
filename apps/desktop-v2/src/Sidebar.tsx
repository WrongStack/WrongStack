import {
  Activity,
  Box,
  Boxes,
  Brain,
  Columns3,
  FileCode2,
  Folder,
  FolderPlus,
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
import { isLive } from './model';
import { addProject, native } from './platform';
import type { DesktopController, ProjectPage } from './useDesktop';

/**
 * WebUI's calm layout: a narrow icon rail with a few pinned views and a Tools launcher for the
 * rest, beside one list of projects and their sessions. Every view stays one click away; none of
 * them competes for space with the conversation.
 */
const PINNED: Array<{ id: ProjectPage; label: string; Icon: typeof Brain }> = [
  { id: 'files', label: 'Files', Icon: FileCode2 },
  { id: 'changes', label: 'Changes', Icon: GitCompareArrows },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'kanban', label: 'Kanban', Icon: Columns3 },
];
const TOOLS: Array<{ id: ProjectPage; label: string; Icon: typeof Brain }> = [
  { id: 'atlas', label: 'Code Atlas', Icon: Network },
  { id: 'goals', label: 'Goals', Icon: Target },
  { id: 'sdd', label: 'SDD', Icon: Workflow },
  { id: 'mailbox', label: 'Mailbox', Icon: Mail },
  { id: 'chronicle', label: 'Chronicle', Icon: Activity },
  { id: 'roster', label: 'Agent Roster', Icon: Users },
  { id: 'live-fleet', label: 'Live fleet', Icon: Network },
  { id: 'history', label: 'Session history', Icon: History },
  { id: 'kit', label: 'Project Kit', Icon: Box },
  { id: 'techstack', label: 'TechStack', Icon: Boxes },
  { id: 'deadcode', label: 'Dead Code', Icon: ScanSearch },
  { id: 'design', label: 'Design Studio', Icon: Palette },
  { id: 'reviews', label: 'Chimera Reviews', Icon: ShieldCheck },
];

function ToolsLauncher({
  page,
  onOpen,
}: {
  page: ProjectPage | undefined;
  onOpen: (page: ProjectPage) => void;
}) {
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
        aria-label="Project tools"
        title="Project tools"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Shapes size={17} />
      </button>
      {open && (
        <div className="rail-popover">
          {TOOLS.map(({ id, label, Icon }) => (
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
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ vm }: { vm: DesktopController }) {
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
      <nav className="rail" aria-label="Main navigation">
        <button
          type="button"
          className="rail-brand"
          aria-label="WrongStack home"
          title="WrongStack"
          onClick={() => goTo('fleet')}
        >
          <span className="brand-mark">
            <img src="/wrongstack-mark.svg" alt="" width="28" height="14" />
          </span>
        </button>
        {main('fleet', 'Mission control', LayoutGrid, vm.active.length)}
        {main('projects', 'Projects', Folder)}
        {main('activity', 'Activity', Activity)}
        <div className="rail-spacer" />
        <button
          type="button"
          className={`rail-button ${section === 'engine' ? 'active' : ''}`}
          aria-label="Appearance"
          title="Appearance"
          onClick={() => goTo('engine')}
        >
          <Palette size={17} />
        </button>
        <button
          type="button"
          className={`rail-button ${section === 'wrongstack' ? 'active' : ''}`}
          aria-label="WrongStack settings"
          title="WrongStack settings"
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
          <span>Find anything</span>
          <kbd>Ctrl K</kbd>
        </button>
        {currentProject && (
          <nav className="project-views" aria-label={`${currentProject.name} workspace`}>
            {PINNED.map(({ id, label, Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => vm.openProjectPage(currentProject.id, id)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
            <ToolsLauncher page={page} onOpen={(id) => vm.openProjectPage(currentProject.id, id)} />
          </nav>
        )}
        <div className="explorer-caption">
          <span>Projects</span>
          <button
            type="button"
            aria-label="Add project"
            title="Add project"
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
                    aria-label={`New session in ${p.name}`}
                    title="New session"
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
                    {s.kind === 'terminal' && <small>terminal</small>}
                  </button>
                ))}
              </div>
            );
          })}
          {!snapshot.projects.length && (
            <p className="sidebar-empty">Add a project folder to start a session.</p>
          )}
          <button
            type="button"
            className="add-project"
            disabled={!native || pending}
            onClick={() => void run(addProject)}
          >
            <FolderPlus size={14} /> Add project
          </button>
        </div>
      </div>
    </aside>
  );
}
