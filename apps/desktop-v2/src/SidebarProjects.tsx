import { ChevronDown, Folder, GripVertical, Plus, Trash2 } from 'lucide-react';
import { type CSSProperties, useId, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { markHue, monogram } from './mark-hue';
import type { Project } from './model';
import { native, request } from './platform';
import { useProjectMenuText } from './project-menu-text';
import { SidebarSessionRow } from './SidebarSessionRow';
import { sidebarSessionsByProject } from './session-layout';
import type { DesktopController } from './useDesktop';
import './sidebar-projects.css';

export type ProjectMenuController = Pick<
  DesktopController,
  | 'snapshot'
  | 'project'
  | 'selected'
  | 'pending'
  | 'openSessionIds'
  | 'run'
  | 'openProjectPage'
  | 'newSession'
  | 'jumpToSession'
  | 'closeSessionTab'
>;
const DRAG_TYPE = 'application/x-wrongstack-project';
const COLLAPSED_KEY = 'wrongstack.desktop.collapsedProjects';

/** Projects whose session list is hidden; a convenience, so an unreadable store means none. */
function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** A project move is saved on drop, never on hover; aborted and external drags do nothing. */
export function SidebarProjects({ vm }: { vm: ProjectMenuController }) {
  const { t } = useDesktopText();
  const text = useProjectMenuText();
  const hintId = useId();
  const dragged = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [reorderId, setReorderId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [moveError, setMoveError] = useState('');
  const [moving, setMoving] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const toggleCollapsed = (id: string) => {
    const next = collapsed.includes(id)
      ? collapsed.filter((item) => item !== id)
      : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      // Remembering the choice is a convenience; a blocked store keeps it for this window.
    }
  };
  const moveLock = useRef(false);
  const projects = vm.snapshot.projects;
  const sessionsByProject = useMemo(
    () => sidebarSessionsByProject(vm.snapshot.sessions, vm.openSessionIds),
    [vm.snapshot.sessions, vm.openSessionIds],
  );
  const from = projects.findIndex((p) => p.id === reorderId);
  const to = projects.findIndex((p) => p.id === destinationId);
  const reorder = projects[from];
  const disabled = !native || vm.pending || moving;
  const reset = () => {
    dragged.current = null;
    setTarget(null);
  };
  const move = async (id: string, target: string, after: boolean, dialog = false) => {
    if (disabled || moveLock.current) return;
    moveLock.current = true;
    setMoving(true);
    setMoveError('');
    setAnnouncement('');
    let saved = false;
    try {
      await vm.run(async () => {
        try {
          await request('project-menu.move', { id, target, after });
          saved = true;
        } catch (error) {
          if (dialog) setMoveError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      });
    } finally {
      moveLock.current = false;
      setMoving(false);
    }
    if (!saved) return;
    const name = projects.find((p) => p.id === id)?.name ?? '';
    setAnnouncement(text('moved', name));
    if (dialog) setReorderId('');
  };
  return (
    <>
      <span className="project-menu-sr" id={hintId}>
        {text('hint')}
      </span>
      <span className="project-menu-status" role="status">
        {announcement}
      </span>
      {projects.map((p, i) => (
        <div key={p.id} className="project-branch">
          <div
            className="project-branch-heading"
            data-selected={vm.project === p.id}
            data-drop={target?.id === p.id ? (target.after ? 'after' : 'before') : undefined}
          >
            <button
              type="button"
              className="project-drag-handle"
              draggable={!disabled}
              disabled={!native || projects.length < 2}
              aria-disabled={disabled || undefined}
              aria-haspopup="dialog"
              aria-label={text('drag', p.name)}
              aria-describedby={hintId}
              title={text('drag', p.name)}
              onDragStart={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                dragged.current = p.id;
                event.dataTransfer.setData(DRAG_TYPE, p.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={reset}
              onClick={() => {
                if (disabled) return;
                setReorderId(p.id);
                setDestinationId(p.id);
                setMoveError('');
              }}
              onKeyDown={(event) => {
                if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const after = event.key === 'ArrowDown';
                const neighbor = vm.snapshot.projects[i + (after ? 1 : -1)];
                if (!disabled && neighbor) void move(p.id, neighbor.id, after);
              }}
            >
              <GripVertical size={13} />
            </button>
            <button
              type="button"
              className={`project-item ${vm.project === p.id ? 'selected' : ''}`}
              aria-current={vm.project === p.id ? 'location' : undefined}
              title={p.root.replace(/^\\\\\?\\/, '')}
              onClick={() => vm.openProjectPage(p.id)}
              onDragOver={(event) => {
                if (
                  disabled ||
                  !dragged.current ||
                  dragged.current === p.id ||
                  !event.dataTransfer.types.includes(DRAG_TYPE)
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const box = event.currentTarget.getBoundingClientRect();
                setTarget({ id: p.id, after: event.clientY > box.top + box.height / 2 });
              }}
              onDragLeave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  setTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragged.current;
                const box = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > box.top + box.height / 2;
                reset();
                if (!disabled && id && id !== p.id && event.dataTransfer.getData(DRAG_TYPE) === id)
                  void move(id, p.id, after);
              }}
            >
              {/* A monogram tinted by the project's name: the same project, the same mark. */}
              <span
                className="project-folder-icon project-mark"
                aria-hidden="true"
                style={{ '--mark-hue': markHue(p.name) } as CSSProperties}
              >
                {monogram(p.name)}
              </span>
              <span>{p.name}</span>
            </button>
            {sessionsByProject.get(p.id)?.length ? (
              <span className="project-session-count" aria-hidden="true">
                {sessionsByProject.get(p.id)?.length}
              </span>
            ) : null}
            <span className="project-actions">
              {sessionsByProject.get(p.id)?.length ? (
                <button
                  type="button"
                  className="project-collapse"
                  aria-expanded={!collapsed.includes(p.id)}
                  aria-label={t(
                    collapsed.includes(p.id) ? 'explorer.showSessions' : 'explorer.hideSessions',
                    { name: p.name },
                  )}
                  title={t(
                    collapsed.includes(p.id) ? 'explorer.showSessions' : 'explorer.hideSessions',
                    { name: p.name },
                  )}
                  onClick={() => toggleCollapsed(p.id)}
                >
                  <ChevronDown size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className="project-new-session"
                aria-label={t('explorer.newSessionIn', { name: p.name })}
                title={t('explorer.newSession')}
                disabled={disabled}
                onClick={() => vm.newSession(p.id)}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className="project-remove"
                aria-label={text('remove', p.name)}
                title={text('remove', p.name)}
                disabled={disabled}
                onClick={() => setConfirming(p)}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
          <div className="project-branch-sessions" hidden={collapsed.includes(p.id)}>
            {sessionsByProject.get(p.id)?.map((s) => (
              <SidebarSessionRow
                key={s.id}
                session={s}
                chosen={vm.selected === s.id}
                disabled={disabled}
                onOpen={vm.jumpToSession}
                run={vm.run}
                onRemoved={vm.closeSessionTab}
              />
            ))}
          </div>
        </div>
      ))}
      {reorder && (
        <Modal title={text('reorderTitle')} onClose={() => !moving && setReorderId('')}>
          <form
            className="project-order-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && to >= 0 && to !== from)
                void move(reorder.id, destinationId, to > from, true);
            }}
          >
            <h2>{text('reorderTitle')}</h2>
            <p className="project-order-help">{text('reorderBody')}</p>
            <div className="project-order-identity">
              <Folder size={18} aria-hidden="true" />
              <div>
                <strong>{reorder.name}</strong>
                <code>{reorder.root.replace(/^\\\\\?\\/, '')}</code>
              </div>
            </div>
            <label>
              {text('position')}
              <select
                value={to >= 0 ? destinationId : reorderId}
                disabled={disabled}
                onChange={(event) => {
                  setDestinationId(event.currentTarget.value);
                  setMoveError('');
                }}
              >
                {projects.map((p, index) => (
                  <option key={p.id} value={p.id}>
                    {index + 1}. {p.id === reorder.id ? text('current') : p.name}
                  </option>
                ))}
              </select>
            </label>
            {moveError && (
              <p role="alert" className="project-order-error">
                {moveError}
              </p>
            )}
            <div className="session-remove-actions">
              <button
                type="button"
                className="button secondary"
                disabled={moving}
                onClick={() => setReorderId('')}
              >
                {t('explorer.cancel')}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={disabled || to < 0 || to === from}
              >
                {text(moving ? 'saving' : 'save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {confirming && (
        <Modal title={text('title', confirming.name)} onClose={() => setConfirming(null)}>
          <h2>{text('title', confirming.name)}</h2>
          <p className="session-remove-body">{text('body')}</p>
          <div className="session-remove-actions">
            <button
              type="button"
              className="button secondary"
              disabled={vm.pending}
              onClick={() => setConfirming(null)}
            >
              {t('explorer.cancel')}
            </button>
            <button
              type="button"
              className="button danger"
              disabled={disabled}
              onClick={() => {
                const id = confirming.id;
                void vm.run(async () => {
                  await request('project-menu.remove', { id });
                  setConfirming(null);
                });
              }}
            >
              {t('explorer.removeConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
