import { Copy, FolderOpen, Pencil, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useDesktopText } from './desktop-i18n';
import { FileContextMenu } from './FileContextMenu';
import { fileName } from './file-model';
import { showInFileManager } from './file-save';
import type { FileWorkspaceModel } from './file-workspace-model';
import type { Action } from './file-workspace-types';
import { GitHunkReview } from './GitHunkReview';
import { MergeConflictReview } from './MergeConflictReview';

export function FileWorkspaceActionDialogs({ model }: { model: FileWorkspaceModel }) {
  const {
    command,
    t,
    active,
    busy,
    error,
    setError,
    action,
    setAction,
    value,
    setValue,
    hunkReview,
    setHunkReview,
    mergeReview,
    setMergeReview,
    menu,
    setMenu,
    docs,
    changes,
    asGitPath,
    reload,
    refreshDiff,
    run,
    updateDocument,
    save,
    close,
    startAction,
    confirm,
  } = model;
  return (
    <>
      {hunkReview && active && (
        <GitHunkReview
          path={asGitPath(active)}
          command={command}
          onClose={() => setHunkReview(false)}
          onApplied={() => {
            void reload();
            refreshDiff();
          }}
        />
      )}
      {mergeReview && active && (
        <MergeConflictReview
          path={asGitPath(active)}
          command={command}
          onClose={() => setMergeReview(false)}
          onResolved={() => {
            void reload();
            refreshDiff();
          }}
        />
      )}
      {menu && (
        <FileContextMenu
          label={t('fileView.menuLabel', { name: fileName(menu.path) })}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        >
          <small>{fileName(menu.path)}</small>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.path).catch(() => {});
              setMenu(null);
            }}
          >
            <Copy size={14} />
            {t('fileView.copyPath')}
          </button>
          <button type="button" role="menuitem" onClick={() => startAction('rename', menu.path)}>
            <Pencil size={14} />
            {t('fileView.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void showInFileManager(command, menu.path).catch((e: Error) => setError(e.message));
            }}
          >
            <FolderOpen size={14} />
            {t('fileView.showInManager')}
          </button>
          <button type="button" role="menuitem" onClick={() => startAction('move', menu.path)}>
            <FolderOpen size={14} />
            {t('fileView.moveTo')}
          </button>
          {changes.some((file) => file['path'] === asGitPath(menu.path)) && (
            <button type="button" role="menuitem" onClick={() => startAction('discard', menu.path)}>
              <Undo2 size={14} />
              {t('fileView.discard')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => startAction('delete', menu.path)}
          >
            <Trash2 size={14} />
            {t('fileView.delete')}
          </button>
        </FileContextMenu>
      )}
      {action && (
        <FileActionDialog
          action={action}
          value={value}
          setValue={setValue}
          busy={busy}
          error={error}
          onClose={() => {
            setAction(null);
            setError('');
          }}
          onConfirm={confirm}
          onDiscard={() => {
            if (action.kind === 'close') close(action.path, true);
            else if (action.kind === 'conflict')
              void run(async () => {
                if (!action.sha256) throw new Error(t('fileView.removedFromDisk'));
                const reviewed = action;
                await save(action.path, action.sha256);
                // A newer disk version replaces this review instead of closing it.
                setAction((current) => (current === reviewed ? null : current));
              });
          }}
          onSave={() =>
            void run(async () => {
              await save(action.path);
              if (docs.current[action.path]?.saved === docs.current[action.path]?.content)
                close(action.path, true);
            })
          }
          onReload={() =>
            void run(async () => {
              const result = await command('files.read', { filePath: action.path }, ['files.read']);
              const content = String(result['content'] ?? '');
              updateDocument(action.path, { content, saved: content });
              setAction(null);
            })
          }
        />
      )}
    </>
  );
}

function FileActionDialog({
  action,
  value,
  setValue,
  busy,
  error,
  onClose,
  onConfirm,
  onDiscard,
  onSave,
  onReload,
}: {
  action: Action;
  value: string;
  setValue: (value: string) => void;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onReload: () => void;
}) {
  const { t } = useDesktopText();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const title = t(`fileView.title.${action.kind}`);
  const destructive = ['delete', 'discard'].includes(action.kind);
  return (
    <dialog ref={dialog} className="modal file-action-dialog" aria-label={title} onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t('fileView.closeAction')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <p className="file-action-path">
          {action.path}
          {action.line ? ` · ${t('fileView.atLine', { line: action.line })}` : ''}
        </p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        {destructive ? (
          <p>{action.kind === 'delete' ? t('fileView.deleteBody') : t('fileView.discardBody')}</p>
        ) : action.kind === 'close' ? (
          <p>{t('fileView.closeBody')}</p>
        ) : action.kind === 'conflict' ? (
          <p>{t('fileView.conflictDiskBody')}</p>
        ) : (
          <label htmlFor="file-action-value">
            {action.kind === 'comment'
              ? t('fileView.reviewNote')
              : action.kind === 'commit'
                ? t('fileView.commitMessage')
                : action.kind === 'move'
                  ? t('fileView.destination')
                  : t('fileView.relativePath')}
            {action.kind === 'comment' || action.kind === 'commit' ? (
              <textarea
                id="file-action-value"
                aria-label={
                  action.kind === 'comment' ? t('fileView.reviewNote') : t('fileView.commitMessage')
                }
                rows={4}
                required
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <input
                id="file-action-value"
                aria-label={
                  action.kind === 'move' ? t('fileView.destination') : t('fileView.relativePath')
                }
                required={action.kind !== 'move'}
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
        )}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t('fileView.cancel')}
          </button>
          {action.kind === 'close' ? (
            <>
              <button type="button" className="button secondary danger" onClick={onDiscard}>
                {t('fileView.discardDraft')}
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={onSave}>
                {t('fileView.saveClose')}
              </button>
            </>
          ) : action.kind === 'conflict' ? (
            <>
              <button type="button" className="button secondary" onClick={onReload}>
                {t('fileView.reload')}
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={onDiscard}>
                {t('fileView.overwrite')}
              </button>
            </>
          ) : (
            <button
              type="submit"
              disabled={busy}
              className={`button ${destructive ? 'secondary danger' : 'primary'}`}
            >
              {busy ? t('fileView.working') : title}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
