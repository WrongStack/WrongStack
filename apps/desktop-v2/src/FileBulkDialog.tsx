import { useRef, useState } from 'react';
import { bulkDestination, bulkRenamePlan, bulkSummary, runBulk, topLevelPaths } from './file-bulk';
import { Modal } from './Modal';

/**
 * Confirms and runs a move, rename or delete over the selected files and folders, one engine
 * operation per item, then reports exactly which items changed.
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
  onClose: () => void;
  onFinished: (summary: string, changed: string[]) => void;
}) {
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
      kind === 'move' &&
      isDirectory(path) &&
      (destination === path || destination.startsWith(`${path}/`)),
  );
  // Copies read the saved file, so unsaved editor text would not be copied; folders are refused.
  const folders = kind === 'copy' ? items.filter(isDirectory) : [];
  const blocked =
    folders.length > 0 ||
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
          {kind === 'move'
            ? 'Move'
            : kind === 'copy'
              ? 'Copy'
              : kind === 'rename'
                ? 'Rename'
                : 'Delete'}{' '}
          {items.length} selected {items.length === 1 ? 'item' : 'items'}
        </h2>
        <ul aria-label={kind === 'rename' ? 'Rename preview' : 'Selected items'}>
          {items.map((path) => (
            <li key={path}>
              {path}
              {isDirectory(path) ? '/' : ''}
              {renameTo.has(path) && <> → {renameTo.get(path)!.split('/').pop()}</>}
            </li>
          ))}
        </ul>
        {paths.length > items.length && (
          <p className="field-help">
            Items inside a selected folder are included with that folder.
          </p>
        )}
        {kind === 'move' || kind === 'copy' ? (
          <label>
            Destination folder (project-relative; empty is the project root)
            <input
              aria-label={kind === 'copy' ? 'Bulk copy destination' : 'Bulk move destination'}
              value={target}
              disabled={running}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
        ) : kind === 'rename' ? (
          <div className="file-bulk-rename">
            <label>
              Find in names
              <input
                aria-label="Find in names"
                value={find}
                disabled={running}
                onChange={(event) => setFind(event.target.value)}
              />
            </label>
            <label>
              Replace with
              <input
                aria-label="Replace in names"
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
              Match case
            </label>
            <p className="field-help">
              Literal text in each name is replaced; folders stay where they are. An existing item
              with the new name is never overwritten: that rename fails and is reported.
              {find && plan.unchanged.length > 0 ? ` ${plan.unchanged.length} unchanged.` : ''}
            </p>
          </div>
        ) : (
          <p>
            Selected folders are deleted with their contents. Each item is deleted separately; the
            result lists any that fail.
          </p>
        )}
        {unsaved.length > 0 && (
          <p role="alert" className="session-error">
            Save or close edited files first: {unsaved.join(', ')}.
          </p>
        )}
        {kind === 'copy' && (
          <p className="field-help">
            Text files are copied from their saved version; an existing file with the same name is
            never overwritten. Binary and very large files are refused per item.
          </p>
        )}
        {folders.length > 0 && (
          <p role="alert" className="session-error">
            Folders cannot be copied yet; unselect: {folders.join(', ')}.
          </p>
        )}
        {intoItself.length > 0 && (
          <p role="alert" className="session-error">
            A folder cannot move into itself: {intoItself.join(', ')}.
          </p>
        )}
        {kind === 'rename' && plan.problems.length > 0 && (
          <ul role="alert" className="session-error" aria-label="Rename problems">
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
            {running ? 'Stop after current item' : 'Cancel'}
          </button>
          <button
            type="submit"
            className={`button ${kind === 'delete' ? 'danger' : 'primary'}`}
            disabled={blocked || running}
          >
            {running
              ? 'Working…'
              : kind === 'move' || kind === 'copy'
                ? `${kind === 'move' ? 'Move' : 'Copy'} ${items.length} to ${destination === '.' ? 'project root' : destination}`
                : kind === 'rename'
                  ? `Rename ${plan.steps.length}`
                  : `Delete ${items.length}`}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
