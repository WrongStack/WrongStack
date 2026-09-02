import type { DesktopRuntimeRecord, DesktopWebuiCommand } from '../../shared/types.js';
import type { IconName } from './icons.js';
import {
  basenameFromPath,
  escapeAttr,
  escapeHtml,
  runtimeProjectKey,
  type RuntimeProjectGroup,
} from './renderer-utils.js';

export interface RuntimeGroupRenderContext {
  activeRuntimeId: string | null;
  allRuntimeCount: number;
  runtimeGroupState: Record<string, boolean>;
  t: (key: string) => string;
  iconSvg: (name: IconName) => string;
  launcherCommandKey: (command: DesktopWebuiCommand) => string;
}

export function groupRuntimesByProject(
  runtimes: DesktopRuntimeRecord[],
  t: (key: string) => string,
): RuntimeProjectGroup[] {
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
      name:
        runtime.kind === 'global-settings'
          ? t('globalSettings')
          : basenameFromPath(runtime.root) || runtime.name,
      root: runtime.root,
      kind: runtime.kind,
      sessions: [runtime],
    });
  }
  return [...groups.values()];
}

export function runtimeGroupIsOpen(
  group: RuntimeProjectGroup,
  ctx: Pick<RuntimeGroupRenderContext, 'activeRuntimeId' | 'allRuntimeCount' | 'runtimeGroupState'>,
): boolean {
  if (group.sessions.some((runtime) => runtime.id === ctx.activeRuntimeId)) return true;
  const stored = ctx.runtimeGroupState[group.key];
  if (typeof stored === 'boolean') return stored;
  return ctx.allRuntimeCount === group.sessions.length;
}

export function renderRuntimeGroup(
  group: RuntimeProjectGroup,
  ctx: RuntimeGroupRenderContext,
): string {
  const active = group.sessions.some((runtime) => runtime.id === ctx.activeRuntimeId);
  const firstSession = group.sessions[0];
  const open = runtimeGroupIsOpen(group, ctx);
  const sessionLabel =
    group.sessions.length === 1 ? '1 session' : `${group.sessions.length} sessions`;
  return `
    <div class="runtime-project-group ${active ? 'active' : ''} ${open ? 'open' : 'collapsed'}" data-runtime-group="${escapeAttr(group.key)}">
      <div class="runtime-project-header">
        <button class="runtime-project-toggle" data-action="toggle-runtime-group" data-runtime-group-key="${escapeAttr(group.key)}" aria-expanded="${open ? 'true' : 'false'}" title="${escapeAttr(group.root)}">
          <span class="runtime-chevron">${ctx.iconSvg('chevron')}</span>
          ${ctx.iconSvg(group.kind === 'global-settings' ? 'settings' : 'folder')}
          <span class="runtime-project-copy">
            <span class="runtime-name">${escapeHtml(group.name)}</span>
            <span class="runtime-path">${escapeHtml(group.root)}</span>
          </span>
          ${renderRuntimeGroupStatus(group)}
          <span class="runtime-session-count">${escapeHtml(sessionLabel)}</span>
        </button>
        ${
          group.kind === 'project' && firstSession
            ? `<button class="icon-button runtime-add-session" title="${ctx.t('newSession')}" data-action="new-project-session" data-runtime="${escapeAttr(firstSession.id)}">${ctx.iconSvg('plus')}</button>`
            : ''
        }
      </div>
      ${
        open
          ? `<div class="runtime-session-list">${group.sessions.map((runtime, index) => renderRuntimeSession(runtime, index + 1, ctx)).join('')}</div>`
          : ''
      }
    </div>
  `;
}

function renderRuntimeGroupStatus(group: RuntimeProjectGroup): string {
  const statuses: DesktopRuntimeRecord['status'][] = ['error', 'starting', 'running', 'stopped'];
  const activeStatuses = statuses.filter((status) =>
    group.sessions.some((runtime) => runtime.status === status),
  );
  return `<span class="runtime-status-stack" aria-hidden="true">${activeStatuses
    .map((status) => `<span class="status-dot status-${escapeAttr(status)}"></span>`)
    .join('')}</span>`;
}

function renderRuntimeSession(
  runtime: DesktopRuntimeRecord,
  index: number,
  ctx: RuntimeGroupRenderContext,
): string {
  const isActive = runtime.id === ctx.activeRuntimeId;
  const label = runtime.kind === 'global-settings' ? ctx.t('settings') : `Session ${index}`;
  const meta =
    runtime.status === 'error'
      ? (runtime.error ?? ctx.t('error'))
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
        <button class="runtime-session-action primary" title="${ctx.t('quickView')}" data-action="activate" data-runtime="${escapeAttr(runtime.id)}">${ctx.iconSvg('monitor')}<span>${ctx.t('quick')}</span></button>
        <button class="runtime-session-action" title="${ctx.t('openChat')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(ctx.launcherCommandKey({ activity: 'chat', view: 'chat' }))}" data-label="Chat" ${disabled}>${ctx.iconSvg('message')}<span>${ctx.t('chat')}</span></button>
        <button class="runtime-session-action" title="${ctx.t('openTerminal')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(ctx.launcherCommandKey({ terminal: 'toggle' }))}" data-label="Terminal" ${disabled}>${ctx.iconSvg('terminal')}<span>${ctx.t('term')}</span></button>
        <button class="runtime-session-action" title="${ctx.t('openFiles')}" data-action="session-webui-command" data-runtime="${escapeAttr(runtime.id)}" data-command="${escapeAttr(ctx.launcherCommandKey({ activity: 'files', view: 'files' }))}" data-label="Files" ${disabled}>${ctx.iconSvg('files')}<span>${ctx.t('files')}</span></button>
        <button class="runtime-session-icon" title="${ctx.t('openInBrowser')}" data-action="open-browser" data-runtime="${escapeAttr(runtime.id)}" ${disabled}>${ctx.iconSvg('external')}</button>
        <button class="runtime-session-icon" title="${ctx.t('refresh')}" data-action="session-reload-webui" data-runtime="${escapeAttr(runtime.id)}" ${disabled}>${ctx.iconSvg('refresh')}</button>
        <button class="runtime-session-icon danger" title="${ctx.t('closeSession')}" data-action="close" data-runtime="${escapeAttr(runtime.id)}">${ctx.iconSvg('x')}</button>
      </div>
    </div>
  `;
}
