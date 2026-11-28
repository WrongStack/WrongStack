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
  PanelLeft,
  Plus,
  Search,
  Settings,
  Shapes,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { isTypingTarget } from './desktop-shortcuts';
import { PaneSplitter } from './PaneSplitter';
import { ProjectToolsMenu } from './ProjectToolsMenu';
import { paneBounds } from './pane-layout';
import { addProject, native } from './platform';
import { owningTool, projectTools } from './project-tools';
import { SidebarProjects } from './SidebarProjects';
import { requestSettingsSection, useShownSettingsSection } from './settings-section-request';
import type { DesktopController, ProjectPage } from './useDesktop';
import type { WorkbenchExplorer } from './useWorkbenchExplorer';

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
/** Views an open agent conversation already offers in its own tab bar. */
const IN_CONVERSATION: ReadonlySet<ProjectPage> = new Set(['files', 'changes']);

/**
 * The pinned project views to list. An agent conversation shows Files and Changes in its own
 * tab bar, so the sidebar listing them too put the same two places side by side; on project
 * pages, where there is no conversation tab bar, they stay.
 */
function pinnedViews(conversationOpen: boolean): typeof PINNED {
  return conversationOpen ? PINNED.filter(({ id }) => !IN_CONVERSATION.has(id)) : PINNED;
}

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

export function Sidebar({ vm, explorer }: { vm: DesktopController; explorer: WorkbenchExplorer }) {
  const { t } = useDesktopText();
  const {
    snapshot,
    project,
    setProject,
    setSelected,
    section,
    setSection,
    setSearch,
    setDialog,
    pending,
    run,
    currentProject,
  } = vm;
  const { compact, open: explorerOpen, id: explorerId, toggle, dismissOverlay } = explorer;
  const sidebar = useRef<HTMLElement>(null);
  const explorerToggle = useRef<HTMLButtonElement>(null);
  const explorerSearch = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!compact || !explorerOpen) return;
    explorerSearch.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        sidebar.current?.contains(target) ||
        target.closest('.workbench-menu')
      )
        return;
      dismissOverlay();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        document.querySelector('dialog[open]')
      )
        return;
      if (event.target instanceof Element && event.target.closest('.workbench-menu')) return;
      dismissOverlay();
      explorerToggle.current?.focus();
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', onEscape);
    };
  }, [compact, explorerOpen, dismissOverlay]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'b' ||
        isTypingTarget(event.target) ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      explorerToggle.current?.focus();
      toggle();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [toggle]);
  const connectProject = () => run(addProject);
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
    <aside className="sidebar" ref={sidebar} data-explorer-open={explorerOpen}>
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
        <button
          type="button"
          // A toggle, not a place: its open state is a plain icon, never the active page's edge.
          className="rail-button explorer-toggle"
          ref={explorerToggle}
          aria-label={t('explorer.toggle')}
          title={`${t('explorer.toggle')} (Ctrl+B)`}
          aria-controls={explorerId}
          aria-expanded={explorerOpen}
          aria-keyshortcuts="Control+B Meta+B"
          onClick={toggle}
        >
          <PanelLeft size={17} />
        </button>
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
      <div className="explorer" id={explorerId} data-expanded={explorerOpen}>
        <button
          type="button"
          className="quick-search"
          ref={explorerSearch}
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
          <>
            <div className="explorer-caption explorer-caption-first">
              <span>{t('explorer.views')}</span>
            </div>
            <nav
              className="project-views"
              aria-label={t('explorer.workspace', { name: currentProject.name })}
            >
              {pinnedViews(section === 'fleet' && vm.currentSession?.kind === 'agent').map(
                ({ id, Icon }) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={page === id ? 'page' : undefined}
                    onClick={() => vm.openProjectPage(currentProject.id, id)}
                  >
                    <Icon size={15} />
                    <span>{t(`pages.${id}`)}</span>
                  </button>
                ),
              )}
              <ToolsLauncher
                page={page}
                onOpen={(id) => vm.openProjectPage(currentProject.id, id)}
              />
            </nav>
          </>
        )}
        <div className="explorer-caption">
          <span>{t('explorer.projects')}</span>
          <button
            type="button"
            aria-label={t('explorer.addProject')}
            title={t('explorer.addProject')}
            disabled={!native || pending}
            onClick={() => void connectProject()}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="project-tree">
          <SidebarProjects vm={vm} />
          {!snapshot.projects.length && <p className="sidebar-empty">{t('explorer.empty')}</p>}
          <button
            type="button"
            className="add-project"
            disabled={!native || pending}
            onClick={() => void connectProject()}
          >
            <FolderPlus size={14} /> {t('explorer.addProject')}
          </button>
        </div>
      </div>
      {explorerOpen && explorer.width !== undefined && (
        <PaneSplitter
          label={t('explorer.toggle')}
          controls={explorerId}
          side="left"
          width={explorer.width}
          {...paneBounds.explorer}
          onResize={(width) => explorer.setWidth?.('explorer', width)}
        />
      )}
    </aside>
  );
}
