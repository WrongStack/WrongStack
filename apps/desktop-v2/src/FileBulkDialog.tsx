import { useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import {
  batchFailure,
  batchMoveItems,
  bulkDestination,
  bulkRenamePlan,
  bulkSummary,
  type RenameStep,
  runBulk,
  topLevelPaths,
} from './file-bulk';
import { Modal } from './Modal';

/**
 * Confirms and runs a move, rename or delete over the selected files and folders, then reports
 * exactly which items changed. With `moveMany`/`copyMany`/`removeMany` (engines that apply a
 * batch all or nothing) a move, copy, rename or delete is one engine operation; otherwise one
 * per item.
 */
export function FileBulkDialog({
  kind,
  paths,
  initialTarget,
  isDirectory,
  hasUnsaved,
  move,
  copy,
  rename,
  remove,
  moveMany,
  copyMany,
  removeMany,
  onClose,
  onFinished,
}: {
  kind: 'move' | 'copy' | 'rename' | 'delete';
  paths: string[];
  initialTarget: string;
  isDirectory: (path: string) => boolean;
  hasUnsaved: (path: string) => boolean;
  move: (path: string, destination: string) => Promise<void>;
  copy: (path: string, destination: string) => Promise<void>;
  rename: (path: string, newPath: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  moveMany?: ((steps: RenameStep[]) => Promise<void>) | undefined;
  /** Copies every item or none (`files.copy_many`), any file type, within the engine's limits. */
  copyMany?: ((steps: RenameStep[]) => Promise<void>) | undefined;
  /** Resolves with a warning when the items are gone but cleanup was incomplete. */
  removeMany?: ((paths: string[]) => Promise<string | undefined>) | undefined;
  onClose: () => void;
  onFinished: (summary: string, changed: string[]) => void;
}) {
  const { t } = useDesktopText();
  const items = topLevelPaths(paths);
  const [target, setTarget] = useState(initialTarget);
  const [find, setFind] = useState(''),
    [replacement, setReplacement] = useState(''),
    [caseSensitive, setCaseSensitive] = useState(true);
  const plan = bulkRenamePlan(items, find, replacement, caseSensitive);
  const renameTo = new Map(plan.steps.map((step) => [step.from, step.to]));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const unsaved = items.filter(hasUnsaved);
  const destination = bulkDestination(target);
  const intoItself = items.filter(
    (path) =>
      (kind === 'move' || kind === 'copy') &&
      isDirectory(path) &&
      (destination === path || destination.startsWith(`${path}/`)),
  );
  // Copies read the saved files, so unsaved editor text would not be copied.
  const blocked =
    unsaved.length > 0 ||
    intoItself.length > 0 ||
    (kind === 'rename' && (plan.problems.length > 0 || plan.steps.length === 0));
  const work = kind === 'rename' ? plan.steps.map((step) => step.from) : items;
  const verb =
    kind === 'move'
      ? 'Moved'
      : kind === 'copy'
        ? 'Copied'
        : kind === 'rename'
          ? 'Renamed'
          : 'Deleted';
  const start = async () => {
    if (blocked || running) return;
    setRunning(true);
    setError('');
    cancelled.current = false;
    const batch =
      kind === 'delete'
        ? removeMany
        : kind === 'copy'
          ? copyMany
          : kind === 'move' || kind === 'rename'
            ? moveMany
            : undefined;
    if (batch) {
      try {
        const warning =
          kind === 'delete'
            ? await removeMany!(work)
            : kind === 'copy'
              ? await copyMany!(batchMoveItems(work, destination))
              : await moveMany!(
                  batchMoveItems(work, destination, kind === 'rename' ? renameTo : undefined),
                );
        onFinished(
          `${verb} ${work.length} of ${work.length} items.${warning ? ` ${warning}` : ''}`,
          work,
        );
      } catch (failure) {
        setError(batchFailure(failure instanceof Error ? failure.message : String(failure)));
      } finally {
        setRunning(false);
      }
      return;
    }
    try {
      const outcome = await runBulk(
        work,
        (path) =>
          kind === 'move'
            ? move(path, destination)
            : kind === 'copy'
              ? copy(path, destination)
              : kind === 'rename'
                ? rename(path, renameTo.get(path)!)
                : remove(path),
        () => cancelled.current,
      );
      onFinished(bulkSummary(verb, work.length, outcome), outcome.done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal
      onClose={() => {
        if (running) cancelled.current = true;
        else onClose();
      }}
    >
      <form
        className="file-bulk-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h2 id="dialog-title">
          {t(`bulk.${items.length === 1 ? 'titleOne' : 'titleMany'}.${kind}`, {
            count: items.length,
          })}
        </h2>
        <ul aria-label={kind === 'rename' ? t('bulk.preview') : t('fileView.selectedItems')}>
          {items.map((path) => (
            <li key={path}>
              {path}
              {isDirectory(path) ? '/' : ''}
              {renameTo.has(path) && <> → {renameTo.get(path)!.split('/').pop()}</>}
            </li>
          ))}
        </ul>
        {paths.length > items.length && <p className="field-help">{t('bulk.nested')}</p>}
        {kind === 'move' || kind === 'copy' ? (
          <label>
            {t('bulk.destination')}
            <input
              aria-label={kind === 'copy' ? t('bulk.copyDestination') : t('bulk.moveDestination')}
              value={target}
              disabled={running}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
        ) : kind === 'rename' ? (
          <div className="file-bulk-rename">
            <label>
              {t('bulk.findNames')}
              <input
                aria-label={t('bulk.findNames')}
                value={find}
                disabled={running}
                onChange={(event) => setFind(event.target.value)}
              />
            </label>
            <label>
              {t('find.replaceWith')}
              <input
                aria-label={t('bulk.replaceNames')}
                value={replacement}
                disabled={running}
                onChange={(event) => setReplacement(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={caseSensitive}
                disabled={running}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />{' '}
              {t('find.matchCase')}
            </label>
            <p className="field-help">
              {t('bulk.renameHelp')}
              {find && plan.unchanged.length > 0
                ? ` ${t('bulk.unchanged', { count: plan.unchanged.length })}`
                : ''}
            </p>
          </div>
        ) : (
          <p>{t('bulk.deleteHelp')}</p>
        )}
        {unsaved.length > 0 && (
          <p role="alert" className="session-error">
            {t('bulk.unsaved', { paths: unsaved.join(', ') })}
          </p>
        )}
        {kind === 'copy' && copyMany && <p className="field-help">{t('bulk.copyAtomic')}</p>}
        {kind === 'copy' && !copyMany && <p className="field-help">{t('bulk.copyText')}</p>}
        {intoItself.length > 0 && (
          <p role="alert" className="session-error">
            {t(kind === 'copy' ? 'bulk.intoItselfCopy' : 'bulk.intoItselfMove', {
              paths: intoItself.join(', '),
            })}
          </p>
        )}
        {kind === 'rename' && plan.problems.length > 0 && (
          <ul role="alert" className="session-error" aria-label={t('bulk.problems')}>
            {plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              if (running) cancelled.current = true;
              else onClose();
            }}
          >
            {running ? t('bulk.stop') : t('fileView.cancel')}
          </button>
          <button
            type="submit"
            className={`button ${kind === 'delete' ? 'danger' : 'primary'}`}
            disabled={blocked || running}
          >
            {running
              ? t('fileView.working')
              : kind === 'move' || kind === 'copy'
                ? t(kind === 'move' ? 'bulk.moveTo' : 'bulk.copyTo', {
                    count: items.length,
                    target: destination === '.' ? t('bulk.projectRoot') : destination,
                  })
                : kind === 'rename'
                  ? t('bulk.renameCount', { count: plan.steps.length })
                  : t('bulk.deleteCount', { count: items.length })}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
