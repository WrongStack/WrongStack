import type {
  DesktopProjectEntry,
  DesktopRuntimeRecord,
  DesktopStateSnapshot,
  DesktopWebuiStatusSnapshot,
  DesktopWebuiCommand,
} from '../../shared/types.js';
import { getLocale, onLocaleChange, setLocale, SUPPORTED_LOCALES, t } from './i18n.js';
import './styles.css';

/** Locale code → endonym (shown untranslated so a user finds their language in
 *  any UI language, same principle as the WebUI LANGUAGES list). */
const LOCALE_ENDONYMS: Record<string, string> = {
  en: 'English',
  tr: 'Türkçe',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  'pt-BR': 'Português',
};

const appRootElement = document.querySelector<HTMLDivElement>('#app');
if (!appRootElement) throw new Error('Missing #app root');
const appRoot = appRootElement;

let state: DesktopStateSnapshot = {
  activeRuntimeId: null,
  runtimes: [],
  recentProjects: [],
  registeredProjects: [],
  restoring: false,
};
let webuiStatus: DesktopWebuiStatusSnapshot = { runtimeId: null, status: 'idle' };
let busy = false;
let shellError: string | null = null;
const RUNTIME_GROUP_STORAGE_KEY = 'wrongstack.desktop.runtimeGroups';
const SHELL_SIDEBAR_STORAGE_KEY = 'wrongstack.desktop.sidebarCollapsed';
const DESKTOP_PANEL_STORAGE_KEY = 'wrongstack.desktop.panel';
const PROJECT_TAB_STORAGE_KEY = 'wrongstack.desktop.projectTab';
const ICON_NAMES = [
  'agents',
  'branch',
  'chart',
  'check',
  'checklist',
  'chevron',
  'chip',
  'clock',
  'collab',
  'command',
  'compress',
  'cursor',
  'debug',
  'document',
  'download',
  'external',
  'files',
  'folder',
  'folder-plus',
  'gallery',
  'git',
  'history',
  'kanban',
  'keyboard',
  'list',
  'mail',
  'map',
  'message',
  'monitor',
  'phase',
  'plan',
  'plus',
  'project',
  'pulse',
  'refresh',
  'search',
  'settings',
  'shield',
  'skill',
  'spark',
  'target',
  'tasks',
  'terminal',
  'wand',
  'x',
] as const;
type IconName = (typeof ICON_NAMES)[number];
type DesktopPanel = 'workspace' | 'projects' | 'quick';
type ProjectPickerTab = 'recent' | 'registered' | 'all';
type ProjectPickerVariant = 'dock' | 'full' | 'embedded';
let runtimeGroupState = readRuntimeGroupState();
let shellSidebarCollapsed = readShellSidebarCollapsed();
let desktopPanel: DesktopPanel = readDesktopPanel();
let projectPickerTab: ProjectPickerTab = readProjectPickerTab();
let projectSearch = '';
let launcherFeedback: LauncherFeedback | null = null;
let launcherFeedbackSeq = 0;

interface LauncherFeedback {
  id: number;
  state: 'pending' | 'success' | 'error';
  label: string;
  commandKey?: string | undefined;
  message?: string | undefined;
}

interface RuntimeProjectGroup {
  key: string;
  name: string;
  root: string;
  kind: DesktopRuntimeRecord['kind'];
  sessions: DesktopRuntimeRecord[];
}

function activeRuntime(): DesktopRuntimeRecord | undefined {
  return state.runtimes.find((runtime) => runtime.id === state.activeRuntimeId);
}

function render(): void {
  const active = activeRuntime();
  appRoot.innerHTML = `
    <div class="desktop-shell ${shellSidebarCollapsed ? 'shell-collapsed' : ''}">
      <aside class="sidebar">
        ${renderDesktopRail()}
        ${shellSidebarCollapsed ? '' : renderSidebarPane(active)}
      </aside>

      <main class="stage ${active?.status === 'running' ? 'stage-mounted' : ''}">
        ${renderStage(active)}
      </main>
    </div>
  `;
}

function renderDesktopRail(): string {
  return `
    <nav class="desktop-rail" aria-label="${t('desktopNavAria')}">
      <div class="rail-brand" title="WrongStack Desktop">WS</div>
      <div class="rail-section">
        <button class="rail-button accent" title="${t('openProjectFolderTitle')}" data-action="open-project" ${busy ? 'disabled' : ''}>
          ${iconSvg('folder-plus')}
        </button>
        ${renderDesktopPanelButton(t('workspace'), 'monitor', 'workspace')}
        ${renderDesktopPanelButton(t('projects'), 'folder', 'projects', projectCountLabel())}
        ${renderDesktopPanelButton(t('quickActions'), 'command', 'quick')}
      </div>
      ${renderCollapsedRuntimeButtons()}
      <div class="rail-spacer"></div>
      <select
        class="rail-locale-select"
        data-action="set-locale"
        title="${t('settings')}"
        aria-label="${t('settings')}"
      >
        ${SUPPORTED_LOCALES.map(
          (code) =>
            `<option value="${code}"${code === getLocale() ? ' selected' : ''}>${LOCALE_ENDONYMS[code] ?? code}</option>`,
        ).join('')}
      </select>
      <button class="rail-button" title="${t('globalSettings')}" data-action="open-settings" ${busy ? 'disabled' : ''}>
        ${iconSvg('settings')}
      </button>
      <button
        class="rail-button rail-toggle"
        title="${shellSidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}"
        data-action="toggle-shell-sidebar"
        aria-label="${shellSidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}"
        aria-pressed="${shellSidebarCollapsed ? 'true' : 'false'}"
      >
        ${iconSvg('chevron')}
      </button>
    </nav>
  `;
}

function renderDesktopPanelButton(
  label: string,
  icon: IconName,
  panel: DesktopPanel,
  badge?: string,
): string {
  const active = desktopPanel === panel;
  return `
    <button
      class="rail-button ${active ? 'active' : ''}"
      title="${escapeAttr(label)}"
      data-action="select-desktop-panel"
      data-panel="${escapeAttr(panel)}"
      aria-pressed="${active ? 'true' : 'false'}"
    >
      ${iconSvg(icon)}
      ${badge ? `<span class="rail-badge">${escapeHtml(badge)}</span>` : ''}
    </button>
  `;
}

function renderCollapsedRuntimeButtons(): string {
  if (state.runtimes.length === 0) return '';
  return `
    <div class="rail-divider"></div>
    <div class="rail-runtime-list">
      ${state.runtimes.map(renderCollapsedRuntimeButton).join('')}
    </div>
  `;
}

function renderCollapsedRuntimeButton(runtime: DesktopRuntimeRecord): string {
  const active = runtime.id === state.activeRuntimeId;
  return `
    <button
      class="rail-runtime ${active ? 'active' : ''}"
      title="${escapeAttr(`${runtime.name} · ${runtime.root}`)}"
      data-action="activate"
      data-runtime="${escapeAttr(runtime.id)}"
    >
      <span class="status-dot status-${runtime.status}"></span>
      <span>${escapeHtml(runtimeInitials(runtime))}</span>
    </button>
  `;
}

function renderSidebarPane(active: DesktopRuntimeRecord | undefined): string {
  return `
    <section class="sidebar-pane">
      ${renderPaneHeader(active)}
      ${renderPaneBody(active)}
    </section>
  `;
}

function renderPaneHeader(active: DesktopRuntimeRecord | undefined): string {
  const title =
    desktopPanel === 'projects' ? t('projects') : desktopPanel === 'quick' ? t('quick') : t('workspace');
  const subtitle =
    desktopPanel === 'projects'
      ? `${projectCountLabel()} projects`
      : desktopPanel === 'quick'
        ? active?.status === 'running'
          ? t('webuiCommands')
          : t('noActiveWebui')
        : active
          ? active.name
          : state.restoring
            ? t('restoring')
            : t('noProject');
  return `
    <header class="pane-header">
      <div class="pane-title-block">
        <div class="pane-kicker">WrongStack</div>
        <div class="pane-title">${escapeHtml(title)}</div>
      </div>
      <div class="pane-subtitle" title="${escapeAttr(subtitle)}">${escapeHtml(subtitle)}</div>
    </header>
  `;
}

function renderPaneBody(active: DesktopRuntimeRecord | undefined): string {
  if (desktopPanel === 'projects') {
    return `
      <div class="pane-body pane-body-scroll">
        ${renderShellError()}
        ${renderProjectsMenu()}
      </div>
    `;
  }
  if (desktopPanel === 'quick') {
    return `
      <div class="pane-body pane-body-scroll">
        ${renderShellError()}
        ${renderLauncher(active)}
        ${renderActiveProject(active)}
      </div>
    `;
  }
  return `
    <div class="pane-body workspace-pane">
      <div class="workspace-main">
        ${renderShellError()}
        ${renderActiveProject(active)}
        ${renderRuntimeList()}
      </div>
      <div class="workspace-projects">
        ${renderProjectPicker('dock')}
      </div>
    </div>
  `;
}

function renderProjectsMenu(): string {
  return `
    <div class="projects-menu-stack">
      ${renderLauncherFeedback()}
      ${renderProjectSessionTree()}
      ${renderProjectPicker('embedded')}
    </div>
  `;
}

function renderShellError(): string {
  if (!shellError) return '';
  return `
    <div class="shell-error" role="alert">
      <div class="shell-error-copy">${escapeHtml(shellError)}</div>
      <button class="icon-button" title="${t('dismiss')}" data-action="clear-error">
        ${iconSvg('x')}
      </button>
    </div>
  `;
}

function renderActiveProject(active: DesktopRuntimeRecord | undefined): string {
  if (!active) {
    return `
      <section class="panel active-panel">
        <header class="panel-header">
        <span>${t('active')}</span>
        <span class="status-chip idle">${state.restoring ? t('restoring') : t('idle')}</span>
      </header>
        <div class="project-empty">${state.restoring ? `${t('restoring')}...` : t('noProject')}</div>
      </section>
    `;
  }

  return `
    <section class="panel active-panel">
      <header class="panel-header">
        <span>${t('active')}</span>
        <span class="status-chip ${active.status}">${escapeHtml(runtimeStatusLabel(active))}</span>
      </header>
      <div class="active-project">
        <div class="active-title">${escapeHtml(active.name)}</div>
        ${active.kind === 'global-settings' ? `<div class="runtime-kind">${t('globalSettingsWorkspace')}</div>` : ''}
        <div class="active-path">${escapeHtml(active.root)}</div>
        <div class="active-meta">
          <span>HTTP ${active.httpPort}</span>
          <span>WS ${active.wsPort}</span>
        </div>
        ${renderWebuiStatus(active)}
        ${
          active.error
            ? `<div class="runtime-error">${escapeHtml(active.error)}</div>`
            : ''
        }
        ${renderRuntimeLogs(active)}
      </div>
      <div class="action-row project-action-row ${active.kind === 'project' ? '' : 'compact-actions'}">
        ${
          active.kind === 'project'
            ? `<button class="secondary-action project-session-action" data-action="new-project-session" data-runtime="${escapeAttr(active.id)}">
          ${iconSvg('plus')}<span>${t('newSession')}</span>
        </button>`
            : ''
        }
        <button class="icon-tool-button" title="${t('revealProjectFolder')}" data-action="reveal-root" data-runtime="${escapeAttr(active.id)}">
          ${iconSvg('folder')}
        </button>
        <button class="icon-tool-button" title="${t('openInBrowser')}" data-action="open-browser" data-runtime="${escapeAttr(active.id)}">
          ${iconSvg('external')}
        </button>
        <button class="icon-tool-button" title="${t('refresh')}" data-action="reload-webui" data-runtime="${escapeAttr(active.id)}">
          ${iconSvg('refresh')}
        </button>
      </div>
    </section>
  `;
}

function renderWebuiStatus(active: DesktopRuntimeRecord): string {
  const status = effectiveWebuiStatus(active);
  const pending =
    webuiStatus.runtimeId === active.id && webuiStatus.pendingCommands
      ? ` · ${webuiStatus.pendingCommands} queued`
      : '';
  const prefs = renderWebuiPrefBadges(active);
  const label = status === 'ready' ? t('webuiReady') : status === 'loading' ? t('webuiLoading') : status === 'error' ? t('webuiError') : t('webuiIdle');
  return `
    <div class="webui-state">
      <span class="status-dot status-${status === 'ready' ? 'running' : status === 'error' ? 'error' : status === 'loading' ? 'starting' : 'stopped'}"></span>
      <span>${escapeHtml(`${label}${pending}${prefs}`)}</span>
      ${webuiStatus.error && webuiStatus.runtimeId === active.id ? `<span class="webui-error">${escapeHtml(webuiStatus.error)}</span>` : ''}
    </div>
  `;
}

function renderWebuiPrefBadges(active: DesktopRuntimeRecord): string {
  if (webuiStatus.runtimeId !== active.id || !webuiStatus.prefs) return '';
  const labels: string[] = [];
  if (webuiStatus.prefs.yolo === true) labels.push(t('yolo'));
  if (webuiStatus.prefs.nextPrediction === true) labels.push(t('next'));
  if (webuiStatus.prefs.contextAutoCompact === true) labels.push(t('compact'));
  return labels.length > 0 ? ` · ${labels.join(' · ')}` : '';
}

function renderRuntimeLogs(active: DesktopRuntimeRecord): string {
  const logs = active.recentLogs?.filter((line) => line.trim()) ?? [];
  if (logs.length === 0) return '';
  return `
    <details class="runtime-log-details" ${active.status === 'error' ? 'open' : ''}>
      <summary>WebUI output <span>${logs.length}</span></summary>
      <pre>${logs.map(escapeHtml).join('\n')}</pre>
    </details>
  `;
}

function renderLauncher(active: DesktopRuntimeRecord | undefined): string {
  const enabled = Boolean(
    active && active.status === 'running' && effectiveWebuiStatus(active) !== 'error',
  );
  const disabled = enabled ? '' : 'disabled';
  const yoloActive = Boolean(
    active && webuiStatus.runtimeId === active.id && webuiStatus.prefs?.yolo === true,
  );
  return `
    <section class="panel launcher-panel">
      <header class="panel-header">
        <span>${t('quick')}</span>
        <span class="count">${enabled ? t('ready') : t('offline')}</span>
      </header>
      ${renderLauncherFeedback()}
      <div class="quick-action-grid">
        ${[
          renderShortcut(t('chat'), 'message', { activity: 'chat', view: 'chat' }, disabled),
          renderShortcut(t('prompt'), 'cursor', { action: 'focus-chat' }, disabled),
          renderShortcut(t('terminal'), 'terminal', { terminal: true }, disabled),
          renderShortcut(t('newTerm'), 'plus', { terminal: 'new' }, disabled),
          renderShortcut(t('yolo'), 'shield', { pref: { key: 'yolo', toggle: true } }, disabled, yoloActive),
        ].join('')}
      </div>
    </section>
  `;
}

function renderProjectPicker(variant: ProjectPickerVariant): string {
  const allProjects = dedupeProjects([...state.recentProjects, ...state.registeredProjects]);
  const recentProjects = dedupeProjects(state.recentProjects);
  const registeredProjects = dedupeProjects(state.registeredProjects);
  const tabProjects =
    projectPickerTab === 'recent'
      ? recentProjects
      : projectPickerTab === 'registered'
        ? registeredProjects
        : allProjects;
  const query = projectSearch.trim();
  const filteredProjects = query
    ? tabProjects.filter((project) => projectMatchesSearch(project, query))
    : tabProjects;
  const limit = variant === 'dock' ? 8 : variant === 'embedded' ? 18 : 48;
  const visibleProjects = filteredProjects.slice(0, limit);
  const visibleTotal = visibleProjects.length;
  const filteredTotal = filteredProjects.length;
  const total = allProjects.length;
  return `
    <section class="panel projects-panel projects-panel-${variant}">
      <header class="panel-header projects-header">
        <span>${t('projects')}</span>
        <span class="panel-header-actions">
          <span class="count">${visibleTotal}/${filteredTotal || total}</span>
          <button class="panel-header-button" title="${t('registerProjectFolder')}" data-action="register-project" ${busy ? 'disabled' : ''}>
            ${iconSvg('folder-plus')}
          </button>
        </span>
      </header>
      <div class="project-picker">
        ${renderProjectTabs(recentProjects.length, registeredProjects.length, allProjects.length)}
        <div class="project-search-row">
          ${iconSvg('search')}
          <input
            class="project-search-input"
            type="search"
            value="${escapeAttr(projectSearch)}"
            placeholder="${t('findProject')}"
            aria-label="${t('findProject')}"
            autocomplete="off"
            spellcheck="false"
          />
          ${
            projectSearch
              ? `<button class="project-search-clear" title="${t('clearProjectSearch')}" data-action="clear-project-search">${iconSvg('x')}</button>`
              : ''
          }
        </div>
        ${
          variant === 'full' || variant === 'embedded'
            ? `<div class="project-picker-actions">
          <button class="secondary-action compact-action" data-action="open-project" ${busy ? 'disabled' : ''}>
            ${iconSvg('folder')}<span>${t('open')}</span>
          </button>
          <button class="secondary-action compact-action" data-action="register-project" ${busy ? 'disabled' : ''}>
            ${iconSvg('folder-plus')}<span>${t('register')}</span>
          </button>
        </div>`
            : ''
        }
        ${
          visibleProjects.length === 0
            ? `<div class="empty compact-empty">${total === 0 ? t('noRegisteredProjects') : t('noMatchingProjects')}</div>`
            : `<div class="project-list">${visibleProjects.map(renderProjectItem).join('')}</div>`
        }
      </div>
    </section>
  `;
}

function renderProjectTabs(recentCount: number, registeredCount: number, allCount: number): string {
  return `
    <div class="project-tabs" role="tablist" aria-label="${t('projectLists')}">
      ${renderProjectTab('recent', t('recent'), recentCount)}
      ${renderProjectTab('registered', t('registered'), registeredCount)}
      ${renderProjectTab('all', t('all'), allCount)}
    </div>
  `;
}

function renderProjectTab(tab: ProjectPickerTab, label: string, count: number): string {
  const active = projectPickerTab === tab;
  return `
    <button
      class="project-tab ${active ? 'active' : ''}"
      data-action="set-project-tab"
      data-project-tab="${escapeAttr(tab)}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
    >
      <span>${escapeHtml(label)}</span>
      <span>${count}</span>
    </button>
  `;
}

function renderProjectItem(project: DesktopProjectEntry): string {
  const openRuntime = state.runtimes.find((runtime) => sameProjectRoot(runtime.root, project.root));
  const title = project.name || basenameFromPath(project.root) || project.root;
  const subtitle = project.lastWorkingDir || project.root;
  return `
    <div class="project-item-row ${openRuntime ? 'open' : ''}">
      <button
        class="project-item-main"
        data-action="${openRuntime ? 'activate' : 'open-project-path'}"
        ${openRuntime ? `data-runtime="${escapeAttr(openRuntime.id)}"` : `data-project-root="${escapeAttr(project.root)}"`}
        title="${escapeAttr(project.root)}"
      >
        ${iconSvg(openRuntime ? 'project' : 'folder')}
        <span class="project-item-copy">
          <span class="project-item-title">${escapeHtml(title)}</span>
          <span class="project-item-path">${escapeHtml(subtitle)}</span>
        </span>
        ${openRuntime ? `<span class="project-open-dot" title="${t('open')}"></span>` : ''}
      </button>
      <button
        class="project-remove-button"
        data-action="unregister-project"
        data-project-root="${escapeAttr(project.root)}"
        title="${t('removeFromRegistry')}"
        aria-label="${t('removeFromRegistry')}"
      >
        ${iconSvg('x')}
      </button>
    </div>
  `;
}

function projectMatchesSearch(project: DesktopProjectEntry, query: string): boolean {
  const haystack = [
    project.name,
    project.root,
    project.slug,
    project.lastWorkingDir,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderLauncherFeedback(): string {
  if (!launcherFeedback) return '';
  const icon =
    launcherFeedback.state === 'success'
      ? 'check'
      : launcherFeedback.state === 'error'
        ? 'x'
        : 'pulse';
  const text =
    launcherFeedback.message ??
    (launcherFeedback.state === 'pending'
      ? `Opening ${launcherFeedback.label}...`
      : launcherFeedback.state === 'success'
        ? `${launcherFeedback.label} opened`
        : `${launcherFeedback.label} failed`);
  return `
    <div class="launcher-feedback ${launcherFeedback.state}" role="status">
      ${iconSvg(icon)}
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function effectiveWebuiStatus(active: DesktopRuntimeRecord): DesktopWebuiStatusSnapshot['status'] {
  if (webuiStatus.runtimeId === active.id) return webuiStatus.status;
  return active.status === 'running' ? 'loading' : 'idle';
}

function renderShortcut(
  label: string,
  icon: IconName,
  command: DesktopWebuiCommand,
  disabled: string,
  active = false,
): string {
  const commandKey = launcherCommandKey(command);
  const pending = launcherFeedback?.state === 'pending' && launcherFeedback.commandKey === commandKey;
  const disabledAttr = disabled || pending ? 'disabled' : '';
  return `
    <button
      class="shortcut-button ${active ? 'active-shortcut' : ''} ${pending ? 'pending-shortcut' : ''}"
      data-action="webui-command"
      data-command="${escapeAttr(commandKey)}"
      data-label="${escapeAttr(label)}"
      title="${escapeAttr(label)}"
      aria-pressed="${active ? 'true' : 'false'}"
      aria-busy="${pending ? 'true' : 'false'}"
      ${disabledAttr}
    >
      ${iconSvg(icon)}<span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderRuntimeList(): string {
  const groups = groupRuntimesByProject(state.runtimes);
  return `
    <section class="panel runtime-panel">
      <header class="panel-header">
        <span>${t('runtimes')}</span>
        <span class="count">${groups.length}/${state.runtimes.length}</span>
      </header>
      <div class="runtime-list">
        ${
          state.runtimes.length === 0
            ? `<div class="empty">${t('none')}</div>`
            : groups.map(renderRuntimeGroup).join('')
        }
      </div>
    </section>
  `;
}

function renderProjectSessionTree(): string {
  const groups = groupRuntimesByProject(state.runtimes).filter((group) => group.kind === 'project');
  return `
    <section class="panel runtime-panel project-sessions-panel">
      <header class="panel-header">
        <span>${t('sessions')}</span>
        <span class="count">${groups.length}/${groups.reduce((sum, group) => sum + group.sessions.length, 0)}</span>
      </header>
      <div class="runtime-list project-session-tree">
        ${
          groups.length === 0
            ? `<div class="empty compact-empty">${state.restoring ? `${t('restoring')}...` : t('noOpenProjectSessions')}</div>`
            : groups.map(renderRuntimeGroup).join('')
        }
      </div>
    </section>
  `;
}

function groupRuntimesByProject(runtimes: DesktopRuntimeRecord[]): RuntimeProjectGroup[] {
  const groups = new Map<string, RuntimeProjectGroup>();
  for (const runtime of runtimes) {
    const key = runtimeProjectKey(runtime);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(runtime);
      continue;
    }
    groups.set(key, {
      key,
      name: runtime.kind === 'global-settings' ? t('globalSettings') : basenameFromPath(runtime.root) || runtime.name,
      root: runtime.root,
      kind: runtime.kind,
      sessions: [runtime],
    });
  }
  return [...groups.values()];
}

function runtimeProjectKey(runtime: DesktopRuntimeRecord): string {
  if (runtime.kind === 'global-settings') return 'global-settings';
  return `${runtime.kind}:${normalizeRuntimeRoot(runtime.root) || runtime.id}`;
}

function normalizeRuntimeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/g, '').trim().toLowerCase();
}

function sameProjectRoot(left: string, right: string): boolean {
  return normalizeRuntimeRoot(left) === normalizeRuntimeRoot(right);
}

function dedupeProjects(projects: DesktopProjectEntry[]): DesktopProjectEntry[] {
  const seen = new Set<string>();
  const next: DesktopProjectEntry[] = [];
  for (const project of projects) {
    const key = normalizeRuntimeRoot(project.root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(project);
  }
  return next;
}

function basenameFromPath(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  if (!normalized) return root;
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

function renderRuntimeGroup(group: RuntimeProjectGroup): string {
  const active = group.sessions.some((runtime) => runtime.id === state.activeRuntimeId);
  const firstSession = group.sessions[0];
  const open = runtimeGroupIsOpen(group);
  const sessionLabel = group.sessions.length === 1 ? '1 session' : `${group.sessions.length} sessions`;
  return `
    <div class="runtime-project-group ${active ? 'active' : ''} ${open ? 'open' : 'collapsed'}" data-runtime-group="${escapeAttr(group.key)}">
      <div class="runtime-project-header">
        <button
          class="runtime-project-toggle"
          data-action="toggle-runtime-group"
          data-runtime-group-key="${escapeAttr(group.key)}"
          aria-expanded="${open ? 'true' : 'false'}"
          title="${escapeAttr(group.root)}"
        >
          <span class="runtime-chevron">${iconSvg('chevron')}</span>
          ${iconSvg(group.kind === 'global-settings' ? 'settings' : 'folder')}
          <span class="runtime-project-copy">
            <span class="runtime-name">${escapeHtml(group.name)}</span>
            <span class="runtime-path">${escapeHtml(group.root)}</span>
          </span>
          ${renderRuntimeGroupStatus(group)}
          <span class="runtime-session-count">${escapeHtml(sessionLabel)}</span>
        </button>
        ${
          group.kind === 'project' && firstSession
            ? `<button class="icon-button runtime-add-session" title="${t('newSession')}" data-action="new-project-session" data-runtime="${escapeAttr(firstSession.id)}">
          ${iconSvg('plus')}
        </button>`
            : ''
        }
      </div>
      ${
        open
          ? `<div class="runtime-session-list">
        ${group.sessions.map((runtime, index) => renderRuntimeSession(runtime, index + 1)).join('')}
      </div>`
          : ''
      }
    </div>
  `;
}

function runtimeGroupIsOpen(group: RuntimeProjectGroup): boolean {
  if (group.sessions.some((runtime) => runtime.id === state.activeRuntimeId)) return true;
  const stored = runtimeGroupState[group.key];
  if (typeof stored === 'boolean') return stored;
  return state.runtimes.length === group.sessions.length;
}

function renderRuntimeGroupStatus(group: RuntimeProjectGroup): string {
  const statuses: DesktopRuntimeRecord['status'][] = ['error', 'starting', 'running', 'stopped'];
  const activeStatuses = statuses.filter((status) =>
    group.sessions.some((runtime) => runtime.status === status),
  );
  return `
    <span class="runtime-status-stack" aria-hidden="true">
      ${activeStatuses
        .map((status) => `<span class="status-dot status-${escapeAttr(status)}"></span>`)
        .join('')}
    </span>
  `;
}

function renderRuntimeSession(runtime: DesktopRuntimeRecord, index: number): string {
  const isActive = runtime.id === state.activeRuntimeId;
  const label = runtime.kind === 'global-settings' ? t('settings') : `Session ${index}`;
  const meta = runtime.status === 'error'
    ? runtime.error ?? t('error')
    : `HTTP ${runtime.httpPort} · WS ${runtime.wsPort}`;
  const disabled = runtime.status === 'running' ? '' : 'disabled';
  return `
    <div class="runtime-session-row ${isActive ? 'active' : ''}">
      <button class="runtime-session-main" data-action="activate" data-runtime="${escapeAttr(runtime.id)}" title="${escapeAttr(runtime.root)}">
        <span class="status-dot status-${runtime.status}"></span>
        <span class="runtime-session-copy">
          <span class="runtime-session-title">${escapeHtml(label)}</span>
          <span class="runtime-session-meta">${escapeHtml(meta)}</span>
        </span>
      </button>
      <div class="runtime-session-actions" aria-label="${escapeAttr(label)} actions">
        <button class="runtime-session-action primary" title="${t('quickView')}" data-action="activate" data-runtime="${escapeAttr(runtime.id)}">
          ${iconSvg('monitor')}<span>${t('quick')}</span>
        </button>
        <button class="runtime-session-action" title="${t('openChat')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(launcherCommandKey({ activity: 'chat', view: 'chat' }))}" data-label="Chat" ${disabled}>
          ${iconSvg('message')}<span>${t('chat')}</span>
        </button>
        <button class="runtime-session-action" title="${t('openTerminal')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(launcherCommandKey({ terminal: 'toggle' }))}" data-label="Terminal" ${disabled}>
          ${iconSvg('terminal')}<span>${t('term')}</span>
        </button>
        <button class="runtime-session-action" title="${t('openFiles')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(launcherCommandKey({ activity: 'files', view: 'files' }))}" data-label="Files" ${disabled}>
          ${iconSvg('files')}<span>${t('files')}</span>
        </button>
        <button class="runtime-session-icon" title="${t('openInBrowser')}" data-action="open-browser" data-runtime="${escapeAttr(runtime.id)}" ${disabled}>
          ${iconSvg('external')}
        </button>
        <button class="runtime-session-icon" title="${t('refresh')}" data-action="session-reload-webui" data-runtime="${escapeAttr(runtime.id)}" ${disabled}>
          ${iconSvg('refresh')}
        </button>
        <button class="runtime-session-icon danger" title="${t('closeSession')}" data-action="close" data-runtime="${escapeAttr(runtime.id)}">
          ${iconSvg('x')}
        </button>
      </div>
    </div>
  `;
}

function renderStage(active: DesktopRuntimeRecord | undefined): string {
  if (active?.status === 'running') {
    return '<div class="mount-shadow"></div>';
  }
  if (active?.status === 'starting') {
    return `
      <section class="stage-card">
        <div class="stage-kicker">${t('starting')}</div>
        <h1>${escapeHtml(active.name)}</h1>
        <div class="stage-path">${escapeHtml(active.root)}</div>
      </section>
    `;
  }
  if (active?.status === 'error') {
    return `
      <section class="stage-card error-card">
        <div class="stage-kicker">${t('runtimeError')}</div>
        <h1>${escapeHtml(active.name)}</h1>
        <pre>${escapeHtml(active.error ?? t('unknownError'))}</pre>
        ${renderRuntimeLogs(active)}
      </section>
    `;
  }
  return `
    <section class="stage-card">
      <div class="stage-kicker">WrongStack Desktop</div>
      <h1>${state.restoring ? t('restoring') : t('openProject')}</h1>
      <div class="stage-actions">
        <button class="primary-action inline" data-action="open-project" ${busy ? 'disabled' : ''}>
          ${iconSvg('folder-plus')}<span>${t('openProject')}</span>
        </button>
        <button class="secondary-action inline" data-action="register-project" ${busy ? 'disabled' : ''}>
          ${iconSvg('folder')}<span>${t('register')}</span>
        </button>
        <button class="secondary-action inline" data-action="open-settings" ${busy ? 'disabled' : ''}>
          ${iconSvg('settings')}<span>${t('settings')}</span>
        </button>
      </div>
    </section>
  `;
}

function runtimeStatusLabel(runtime: DesktopRuntimeRecord): string {
  if (runtime.status === 'starting') return t('starting');
  if (runtime.status === 'running') return t('running');
  if (runtime.status === 'error') return t('error');
  return t('stopped');
}

async function refresh(): Promise<void> {
  const [nextState, nextWebuiStatus] = await Promise.all([
    window.wrongstackDesktop.getState(),
    window.wrongstackDesktop.getWebuiStatus(),
  ]);
  state = nextState;
  webuiStatus = nextWebuiStatus;
  render();
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  shellError = null;
  render();
  try {
    await fn();
  } catch (err) {
    shellError = toErrorMessage(err);
    console.error(err);
  } finally {
    busy = false;
    render();
  }
}

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    void window.wrongstackDesktop.navigateWebui({ action: 'open-command-palette' });
  }
});

appRoot.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement | null;
  if (!target?.classList.contains('project-search-input')) return;
  const cursor = target.selectionStart ?? target.value.length;
  projectSearch = target.value;
  render();
  focusProjectSearch(cursor);
});

// Language picker (a <select>, so it fires `change`). setLocale updates the
// renderer chrome instantly + pushes to main, which persists it to the shared
// config so every other surface (webui, menu) follows.
appRoot.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement | null;
  if (target?.dataset.action !== 'set-locale') return;
  const match = SUPPORTED_LOCALES.find((c) => c === target.value);
  if (match && match !== getLocale()) {
    setLocale(match);
    render();
  }
});

appRoot.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const actionTarget = target?.closest<HTMLElement>('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  const runtimeId = actionTarget.dataset.runtime;

  if (action === 'webui-command') {
    const raw = actionTarget.dataset.command;
    if (!raw) return;
    const label = actionTarget.dataset.label ?? t('command');
    const commandKey = raw;
    try {
      const command = JSON.parse(raw) as DesktopWebuiCommand;
      setLauncherFeedback({
        state: 'pending',
        label,
        commandKey,
      });
      void window.wrongstackDesktop
        .navigateWebui(command)
        .then((ok) => {
          if (ok) {
            setLauncherFeedback({
              state: 'success',
              label,
              commandKey,
            });
            return;
          }
          const message = t('launcherError');
          shellError = message;
          setLauncherFeedback({
            state: 'error',
            label,
            commandKey,
            message,
          });
        });
    } catch {
      /* malformed DOM data should not break the shell */
    }
    return;
  }

  if (action === 'session-webui-command') {
    if (!runtimeId) return;
    const raw = actionTarget.dataset.command;
    if (!raw) return;
    const label = actionTarget.dataset.label ?? 'WebUI';
    const commandKey = raw;
    try {
      const command = JSON.parse(raw) as DesktopWebuiCommand;
      setLauncherFeedback({
        state: 'pending',
        label,
        commandKey: `${runtimeId}:${commandKey}`,
      });
      void withBusy(async () => {
        state = await window.wrongstackDesktop.activateRuntime(runtimeId);
        const ok = await window.wrongstackDesktop.navigateWebui(command);
        if (ok) {
          setLauncherFeedback({
            state: 'success',
            label,
            commandKey: `${runtimeId}:${commandKey}`,
          });
          return;
        }
        const message = t('sessionLauncherError');
        shellError = message;
        setLauncherFeedback({
          state: 'error',
          label,
          commandKey: `${runtimeId}:${commandKey}`,
          message,
        });
      });
    } catch {
      /* malformed DOM data should not break the shell */
    }
    return;
  }

  if (action === 'clear-error') {
    shellError = null;
    render();
    return;
  }

  if (action === 'clear-project-search') {
    projectSearch = '';
    render();
    focusProjectSearch(0);
    return;
  }

  if (action === 'toggle-shell-sidebar') {
    shellSidebarCollapsed = !shellSidebarCollapsed;
    writeShellSidebarCollapsed();
    void window.wrongstackDesktop.setShellSidebarCollapsed(shellSidebarCollapsed);
    render();
    return;
  }

  if (action === 'select-desktop-panel') {
    const panel = parseDesktopPanel(actionTarget.dataset.panel);
    if (!panel) return;
    desktopPanel = panel;
    writeDesktopPanel();
    render();
    return;
  }

  if (action === 'set-project-tab') {
    const tab = parseProjectPickerTab(actionTarget.dataset.projectTab);
    if (!tab) return;
    projectPickerTab = tab;
    writeProjectPickerTab();
    render();
    return;
  }

  if (action === 'toggle-runtime-group') {
    const key = actionTarget.dataset.runtimeGroupKey;
    if (!key) return;
    const group = groupRuntimesByProject(state.runtimes).find((item) => item.key === key);
    if (!group) return;
    runtimeGroupState = { ...runtimeGroupState, [key]: !runtimeGroupIsOpen(group) };
    writeRuntimeGroupState();
    render();
    return;
  }

  void withBusy(async () => {
    if (action === 'open-project') {
      state = await window.wrongstackDesktop.openProject();
    } else if (action === 'register-project') {
      state = await window.wrongstackDesktop.registerProject();
    } else if (action === 'open-project-path') {
      const root = actionTarget.dataset.projectRoot;
      if (root) state = await window.wrongstackDesktop.openProject(root);
    } else if (action === 'unregister-project') {
      const root = actionTarget.dataset.projectRoot;
      if (root) state = await window.wrongstackDesktop.unregisterProject(root);
    } else if (action === 'new-project-session') {
      state = await window.wrongstackDesktop.openProjectSession(runtimeId);
    } else if (action === 'open-settings') {
      state = await window.wrongstackDesktop.openSettings();
    } else if (action === 'activate' && runtimeId) {
      state = await window.wrongstackDesktop.activateRuntime(runtimeId);
    } else if (action === 'close' && runtimeId) {
      state = await window.wrongstackDesktop.closeRuntime(runtimeId);
    } else if (action === 'open-browser' && runtimeId) {
      await window.wrongstackDesktop.openRuntimeInBrowser(runtimeId);
    } else if (action === 'reveal-root' && runtimeId) {
      await window.wrongstackDesktop.revealRuntimeRoot(runtimeId);
    } else if (action === 'reload-webui' && runtimeId) {
      await window.wrongstackDesktop.reloadWebui();
    } else if (action === 'session-reload-webui' && runtimeId) {
      state = await window.wrongstackDesktop.activateRuntime(runtimeId);
      await window.wrongstackDesktop.reloadWebui();
    }
  });
});

window.wrongstackDesktop.onStateChanged((next) => {
  state = next;
  render();
});

window.wrongstackDesktop.onWebuiStatusChanged((next) => {
  webuiStatus = next;
  render();
});

window.wrongstackDesktop.onShellSidebarCollapsedChanged((collapsed) => {
  shellSidebarCollapsed = collapsed;
  writeShellSidebarCollapsed();
  render();
});

// Re-render whenever the locale changes — user picker OR a config push from
// main (another surface changed the shared language).
onLocaleChange(() => render());

void refresh();
void window.wrongstackDesktop.setShellSidebarCollapsed(shellSidebarCollapsed);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return t('operationFailed');
}

function readRuntimeGroupState(): Record<string, boolean> {
  return readBooleanRecord(RUNTIME_GROUP_STORAGE_KEY);
}

function readShellSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SHELL_SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeShellSidebarCollapsed(): void {
  try {
    window.localStorage.setItem(SHELL_SIDEBAR_STORAGE_KEY, String(shellSidebarCollapsed));
  } catch {
    /* best-effort UI preference */
  }
}

function readDesktopPanel(): DesktopPanel {
  return parseDesktopPanel(readLocalStorageValue(DESKTOP_PANEL_STORAGE_KEY)) ?? 'workspace';
}

function writeDesktopPanel(): void {
  try {
    window.localStorage.setItem(DESKTOP_PANEL_STORAGE_KEY, desktopPanel);
  } catch {
    /* best-effort UI preference */
  }
}

function readProjectPickerTab(): ProjectPickerTab {
  return parseProjectPickerTab(readLocalStorageValue(PROJECT_TAB_STORAGE_KEY)) ?? 'recent';
}

function writeProjectPickerTab(): void {
  try {
    window.localStorage.setItem(PROJECT_TAB_STORAGE_KEY, projectPickerTab);
  } catch {
    /* best-effort UI preference */
  }
}

function readLocalStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseDesktopPanel(value: unknown): DesktopPanel | null {
  return value === 'workspace' || value === 'projects' || value === 'quick' ? value : null;
}

function parseProjectPickerTab(value: unknown): ProjectPickerTab | null {
  return value === 'recent' || value === 'registered' || value === 'all' ? value : null;
}

function readBooleanRecord(key: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

function writeRuntimeGroupState(): void {
  writeBooleanRecord(RUNTIME_GROUP_STORAGE_KEY, runtimeGroupState);
}

function writeBooleanRecord(key: string, value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort UI preference */
  }
}

function launcherCommandKey(command: DesktopWebuiCommand): string {
  return JSON.stringify(command);
}

function runtimeInitials(runtime: DesktopRuntimeRecord): string {
  const source = runtime.kind === 'global-settings' ? t('gs') : runtime.name || basenameFromPath(runtime.root);
  const words = source
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const initials =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : source.slice(0, 2);
  return initials.toUpperCase();
}

function projectCountLabel(): string {
  return String(dedupeProjects([...state.recentProjects, ...state.registeredProjects]).length);
}

function setLauncherFeedback(next: Omit<LauncherFeedback, 'id'>): void {
  launcherFeedbackSeq += 1;
  const id = launcherFeedbackSeq;
  launcherFeedback = { id, ...next };
  render();
  if (next.state === 'pending') return;
  window.setTimeout(() => {
    if (launcherFeedback?.id !== id) return;
    launcherFeedback = null;
    render();
  }, next.state === 'success' ? 1_250 : 3_000);
}

function focusProjectSearch(cursor: number): void {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('.project-search-input');
    if (!input) return;
    input.focus();
    const bounded = Math.max(0, Math.min(cursor, input.value.length));
    input.setSelectionRange(bounded, bounded);
  });
}

const ICON_PATHS: Record<IconName, string> = {
  agents:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9.5" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.9"></path><path d="M16 3.1a4 4 0 0 1 0 7.8"></path>',
  branch:
    '<circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="M9 6h6"></path><path d="M18 9v6"></path><path d="M6 9v3a6 6 0 0 0 6 6h3"></path>',
  chart:
    '<path d="M3 3v18h18"></path><rect x="7" y="12" width="3" height="5"></rect><rect x="12" y="8" width="3" height="9"></rect><rect x="17" y="5" width="3" height="12"></rect>',
  check: '<path d="M20 6L9 17l-5-5"></path>',
  checklist:
    '<path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><path d="M4 6l1 1 2-2"></path><path d="M4 12l1 1 2-2"></path><path d="M4 18l1 1 2-2"></path>',
  chevron: '<path d="M9 18l6-6-6-6"></path>',
  chip:
    '<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M4 9h3"></path><path d="M4 15h3"></path><path d="M17 9h3"></path><path d="M17 15h3"></path><path d="M9 4v3"></path><path d="M15 4v3"></path><path d="M9 17v3"></path><path d="M15 17v3"></path>',
  clock:
    '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  command:
    '<path d="M7 7h.01"></path><path d="M12 7h.01"></path><path d="M17 7h.01"></path><path d="M7 12h.01"></path><path d="M12 12h.01"></path><path d="M17 12h.01"></path><path d="M7 17h.01"></path><path d="M12 17h.01"></path><path d="M17 17h.01"></path>',
  collab:
    '<circle cx="8" cy="8" r="3"></circle><circle cx="16" cy="8" r="3"></circle><path d="M3 20a5 5 0 0 1 10 0"></path><path d="M11 20a5 5 0 0 1 10 0"></path>',
  compress:
    '<path d="M8 3v6H2"></path><path d="M16 3v6h6"></path><path d="M8 21v-6H2"></path><path d="M16 21v-6h6"></path>',
  cursor: '<path d="M4 4l9 17 2-7 7-2L4 4z"></path>',
  debug:
    '<path d="M8 2h8"></path><path d="M9 2v4"></path><path d="M15 2v4"></path><path d="M5 10h14"></path><path d="M7 10v4a5 5 0 0 0 10 0v-4"></path><path d="M3 14h4"></path><path d="M17 14h4"></path><path d="M4 20l3-3"></path><path d="M20 20l-3-3"></path>',
  document:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h6"></path>',
  download:
    '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
  external:
    '<path d="M15 3h6v6"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>',
  files:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
  'folder-plus':
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M12 11v5"></path><path d="M9.5 13.5h5"></path>',
  git:
    '<path d="M7 7h10"></path><path d="M7 12h10"></path><path d="M7 17h10"></path><path d="M4 7h.01"></path><path d="M4 12h.01"></path><path d="M4 17h.01"></path>',
  gallery:
    '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path><path d="M12 7v5l3 2"></path>',
  kanban:
    '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path><path d="M15 4v16"></path><path d="M6 8h.01"></path><path d="M12 12h.01"></path><path d="M18 9h.01"></path>',
  keyboard:
    '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h.01"></path><path d="M11 9h.01"></path><path d="M15 9h.01"></path><path d="M19 9h.01"></path><path d="M7 13h.01"></path><path d="M11 13h.01"></path><path d="M15 13h.01"></path><path d="M7 17h10"></path>',
  list:
    '<path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>',
  mail:
    '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path>',
  map:
    '<path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"></path><path d="M9 3v15"></path><path d="M15 6v15"></path>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
  monitor:
    '<rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 21h8"></path><path d="M12 18v3"></path><path d="M7 13l3-3 2 2 4-5 1 3"></path>',
  phase:
    '<path d="M4 7h6"></path><path d="M14 7h6"></path><path d="M4 17h6"></path><path d="M14 17h6"></path><circle cx="12" cy="7" r="2"></circle><circle cx="12" cy="17" r="2"></circle><path d="M12 9v6"></path>',
  plan:
    '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8"></path><path d="M8 12h8"></path><path d="M8 16h5"></path>',
  plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  project:
    '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M8 4v16"></path><path d="M8 9h13"></path>',
  pulse:
    '<path d="M3 12h4l2-6 4 12 2-6h6"></path>',
  refresh:
    '<path d="M21 12a9 9 0 0 1-15.4 6.4"></path><path d="M3 12A9 9 0 0 1 18.4 5.6"></path><path d="M18 2v5h-5"></path><path d="M6 22v-5h5"></path>',
  search:
    '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>',
  settings:
    '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"></path><path d="M4 12a8 8 0 0 1 .2-1.8l-2-1.5 2-3.4 2.4 1a8 8 0 0 1 3-1.7L10 2h4l.4 2.6a8 8 0 0 1 3 1.7l2.4-1 2 3.4-2 1.5A8 8 0 0 1 20 12a8 8 0 0 1-.2 1.8l2 1.5-2 3.4-2.4-1a8 8 0 0 1-3 1.7L14 22h-4l-.4-2.6a8 8 0 0 1-3-1.7l-2.4 1-2-3.4 2-1.5A8 8 0 0 1 4 12z"></path>',
  shield:
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-5"></path>',
  skill:
    '<path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2z"></path>',
  spark:
    '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"></path><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"></path>',
  target:
    '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1"></circle>',
  tasks:
    '<path d="M4 6h2"></path><path d="M4 12h2"></path><path d="M4 18h2"></path><path d="M10 6h10"></path><path d="M10 12h10"></path><path d="M10 18h10"></path>',
  terminal: '<path d="M4 17l6-5-6-5"></path><path d="M12 19h8"></path>',
  wand:
    '<path d="M15 4l5 5"></path><path d="M14 5l-9 9 5 5 9-9"></path><path d="M5 3v4"></path><path d="M3 5h4"></path><path d="M19 17v4"></path><path d="M17 19h4"></path>',
  x: '<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>',
};

function iconSvg(name: IconName): string {
  return `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}
