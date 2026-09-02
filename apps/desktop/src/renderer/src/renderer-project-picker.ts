import type { DesktopProjectEntry, DesktopRuntimeRecord } from '../../shared/types.js';
import type { IconName } from './icons.js';
import {
  basenameFromPath,
  dedupeProjects,
  escapeAttr,
  escapeHtml,
  sameProjectRoot,
  type ProjectPickerTab,
  type ProjectPickerVariant,
} from './renderer-utils.js';

export interface ProjectPickerRenderContext {
  busy: boolean;
  projectPickerTab: ProjectPickerTab;
  projectSearch: string;
  recentProjects: DesktopProjectEntry[];
  registeredProjects: DesktopProjectEntry[];
  runtimes: DesktopRuntimeRecord[];
  t: (key: string) => string;
  iconSvg: (name: IconName) => string;
}

export function renderProjectPicker(
  variant: ProjectPickerVariant,
  ctx: ProjectPickerRenderContext,
): string {
  const recentProjects = dedupeProjects(ctx.recentProjects);
  const registeredProjects = dedupeProjects(ctx.registeredProjects);
  const allProjects = dedupeProjects([...registeredProjects, ...recentProjects]);
  const tabProjects =
    ctx.projectPickerTab === 'recent'
      ? recentProjects
      : ctx.projectPickerTab === 'registered'
        ? registeredProjects
        : allProjects;
  const query = ctx.projectSearch.trim();
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
        <span>${ctx.t('projects')}</span>
        <span class="panel-header-actions">
          <span class="count">${visibleTotal}/${filteredTotal || total}</span>
          <button class="panel-header-button" title="${ctx.t('registerProjectFolder')}" data-action="register-project" ${ctx.busy ? 'disabled' : ''}>
            ${ctx.iconSvg('folder-plus')}
          </button>
        </span>
      </header>
      <div class="project-picker">
        ${renderProjectTabs(recentProjects.length, registeredProjects.length, allProjects.length, ctx)}
        <div class="project-search-row">
          ${ctx.iconSvg('search')}
          <input
            class="project-search-input"
            type="search"
            value="${escapeAttr(ctx.projectSearch)}"
            placeholder="${ctx.t('findProject')}"
            aria-label="${ctx.t('findProject')}"
            autocomplete="off"
            spellcheck="false"
          />
          ${
            ctx.projectSearch
              ? `<button class="project-search-clear" title="${ctx.t('clearProjectSearch')}" data-action="clear-project-search">${ctx.iconSvg('x')}</button>`
              : ''
          }
        </div>
        ${
          variant === 'full' || variant === 'embedded'
            ? `<div class="project-picker-actions">
          <button class="secondary-action compact-action" data-action="open-project" ${ctx.busy ? 'disabled' : ''}>
            ${ctx.iconSvg('folder')}<span>${ctx.t('open')}</span>
          </button>
          <button class="secondary-action compact-action" data-action="register-project" ${ctx.busy ? 'disabled' : ''}>
            ${ctx.iconSvg('folder-plus')}<span>${ctx.t('register')}</span>
          </button>
        </div>`
            : ''
        }
        ${
          visibleProjects.length === 0
            ? `<div class="empty compact-empty">${total === 0 ? ctx.t('noRegisteredProjects') : ctx.t('noMatchingProjects')}</div>`
            : `<div class="project-list">${visibleProjects.map((project) => renderProjectItem(project, ctx)).join('')}</div>`
        }
      </div>
    </section>
  `;
}

function renderProjectTabs(
  recentCount: number,
  registeredCount: number,
  allCount: number,
  ctx: ProjectPickerRenderContext,
): string {
  return `
    <div class="project-tabs" role="tablist" aria-label="${ctx.t('projectLists')}">
      ${renderProjectTab('recent', ctx.t('recent'), recentCount, ctx)}
      ${renderProjectTab('registered', ctx.t('registered'), registeredCount, ctx)}
      ${renderProjectTab('all', ctx.t('all'), allCount, ctx)}
    </div>
  `;
}

function renderProjectTab(
  tab: ProjectPickerTab,
  label: string,
  count: number,
  ctx: ProjectPickerRenderContext,
): string {
  const active = ctx.projectPickerTab === tab;
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

function renderProjectItem(project: DesktopProjectEntry, ctx: ProjectPickerRenderContext): string {
  const openRuntime = ctx.runtimes.find((runtime) => sameProjectRoot(runtime.root, project.root));
  const registered = ctx.registeredProjects.some((item) =>
    sameProjectRoot(item.root, project.root),
  );
  const recent = ctx.recentProjects.some((item) => sameProjectRoot(item.root, project.root));
  const title = project.name || basenameFromPath(project.root) || project.root;
  const subtitle = project.lastWorkingDir || project.root;
  const actionLabel = openRuntime
    ? ctx.t('quickView')
    : registered
      ? ctx.t('openRegisteredProject')
      : ctx.t('openProject');
  return `
    <div class="project-item-row ${openRuntime ? 'open' : ''} ${registered ? 'registered' : ''} ${recent ? 'recent' : ''}">
      <button
        class="project-item-main"
        data-action="${openRuntime ? 'activate' : 'open-project-path'}"
        ${openRuntime ? `data-runtime="${escapeAttr(openRuntime.id)}"` : `data-project-root="${escapeAttr(project.root)}"`}
        title="${escapeAttr(`${actionLabel} · ${project.root}`)}"
      >
        ${ctx.iconSvg(openRuntime ? 'project' : registered ? 'folder-plus' : 'folder')}
        <span class="project-item-copy">
          <span class="project-item-title">${escapeHtml(title)}</span>
          <span class="project-item-path">${escapeHtml(subtitle)}</span>
        </span>
        <span class="project-source-tags">
          ${registered ? `<span class="project-source-tag registered-tag">${ctx.t('registered')}</span>` : ''}
          ${recent ? `<span class="project-source-tag recent-tag">${ctx.t('recent')}</span>` : ''}
        </span>
        ${openRuntime ? `<span class="project-open-dot" title="${ctx.t('open')}"></span>` : ''}
      </button>
      ${
        registered
          ? `<button
        class="project-remove-button"
        data-action="unregister-project"
        data-project-root="${escapeAttr(project.root)}"
        title="${ctx.t('removeFromProjectRegistry')}"
        aria-label="${ctx.t('removeFromProjectRegistry')}"
      >
        ${ctx.iconSvg('x')}
      </button>`
          : '<span></span>'
      }
    </div>
  `;
}

function projectMatchesSearch(project: DesktopProjectEntry, query: string): boolean {
  const haystack = [project.name, project.root, project.slug, project.lastWorkingDir]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}
