import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import type { Project } from './model';
import { native, request } from './platform';
import { useProjectMenuText } from './project-menu-text';
import { SidebarSessionRow } from './SidebarSessionRow';
import { sidebarSessions } from './session-layout';
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

/** A project move is saved on drop, never on hover; aborted and external drags do nothing. */
export function SidebarProjects({ vm }: { vm: ProjectMenuController }) {
  const { t } = useDesktopText();
  const text = useProjectMenuText();
  const hintId = useId();
  const dragged = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const disabled = !native || vm.pending;
  const reset = () => {
    dragged.current = null;
    setTarget(null);
  };
  const move = (id: string, target: string, after: boolean) =>
    vm.run(async () => {
      await request('project-menu.move', { id, target, after });
      const name = vm.snapshot.projects.find((p) => p.id === id)?.name ?? '';
      setAnnouncement(text('moved', name));
    });
  return (
    <>
      <span className="project-menu-sr" id={hintId}>
        {text('hint')}
      </span>
      <span className="project-menu-sr" role="status">
        {announcement}
      </span>
      {vm.snapshot.projects.map((p, i) => (
        <div key={p.id} className="project-branch">
          <div className="project-branch-heading">
            <button
              type="button"
              className="project-drag-handle"
              draggable={!disabled}
              disabled={disabled}
              aria-label={text('drag', p.name)}
              aria-describedby={hintId}
              title={text('hint')}
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
              title={p.root.replace(/^\\\\\?\\/, '')}
              data-drop={target?.id === p.id ? (target.after ? 'after' : 'before') : undefined}
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
              onDragLeave={() => setTarget(null)}
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
              <span className={`project-symbol color-${i % 4}`} aria-hidden="true">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span>{p.name}</span>
            </button>
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
          </div>
          {sidebarSessions(vm.snapshot.sessions, p.id, vm.openSessionIds).map((s) => (
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
      ))}
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
