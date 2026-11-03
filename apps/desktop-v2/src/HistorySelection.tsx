import { ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import type { Session } from './model';
import { historyTitle } from './project-history-model';
import { recoveryDate } from './session-recovery-model';

type Row = Record<string, unknown>;

/**
 * The selected recorded conversation's heading and actions: copy its id, rename it, return to the
 * desktop conversation that has it open, resume it or continue a copy, and, when no open desktop
 * conversation owns it, delete it after a confirmation, as the WebUI's session list allows.
 */
export function HistorySelection({
  row,
  selected,
  owner,
  busy,
  saving,
  onRename,
  onOpen,
  onRestore,
  onDelete,
}: {
  row: Row;
  selected: string;
  owner: Session | undefined;
  busy: boolean;
  saving: boolean;
  onRename: (row: Row) => void;
  onOpen: (owner: Session) => void;
  onRestore: (restore: { id: string; title: string; mode: 'resume' | 'fork' }) => void;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <header className="history-selection">
      <span className="eyebrow">RECORDED CONVERSATION</span>
      <h2>{historyTitle(row, owner)}</h2>
      <p>
        {String(row['provider'])} / {String(row['model'])} · Started{' '}
        {recoveryDate(row['startedAt'])}
      </p>
      <div>
        <CopyButton text={selected} label="Copy recorded session ID" />
        <button
          type="button"
          className="button secondary small"
          disabled={busy || saving}
          onClick={() => onRename(row)}
        >
          <Pencil size={13} />
          Rename recorded session
        </button>
        {owner && (
          <button type="button" className="button primary small" onClick={() => onOpen(owner)}>
            Open desktop conversation
            <ArrowRight size={13} />
          </button>
        )}
        {!owner && (
          <button
            type="button"
            className="button primary small"
            onClick={() => onRestore({ id: selected, title: historyTitle(row), mode: 'resume' })}
          >
            Resume recorded conversation
          </button>
        )}
        <button
          type="button"
          className="button secondary small"
          onClick={() => onRestore({ id: selected, title: historyTitle(row, owner), mode: 'fork' })}
        >
          Continue a copy
        </button>
        {!owner && !confirmDelete && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy || saving}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={13} />
            Delete…
          </button>
        )}
      </div>
      {confirmDelete && !owner && (
        <div className="history-delete-confirm" role="alert">
          <p>
            Delete “{historyTitle(row)}” and its recorded journal? This cannot be undone. The engine
            refuses while a run is active in it.
          </p>
          <button
            type="button"
            className="button danger small"
            disabled={saving}
            onClick={() => void onDelete([selected]).finally(() => setConfirmDelete(false))}
          >
            Delete recorded session
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirmDelete(false)}
          >
            Keep
          </button>
        </div>
      )}
      <p className="field-help">
        {owner
          ? 'Return to the open desktop conversation without starting another session.'
          : 'Read-only history. Reading does not resume or run the agent.'}{' '}
        File links open the current project file.
      </p>
    </header>
  );
}

/** Removes the empty recorded journals on this page that no open desktop conversation owns. */
export function HistoryEmptyCleanup({
  ids,
  saving,
  onDelete,
}: {
  ids: string[];
  saving: boolean;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  if (!ids.length) return null;
  return confirm ? (
    <span className="history-delete-confirm" role="alert">
      Delete {ids.length} empty recorded {ids.length === 1 ? 'session' : 'sessions'} on this page?
      <button
        type="button"
        className="button danger small"
        disabled={saving}
        onClick={() => void onDelete(ids).finally(() => setConfirm(false))}
      >
        Delete empty
      </button>
      <button type="button" className="button secondary small" onClick={() => setConfirm(false)}>
        Keep
      </button>
    </span>
  ) : (
    <button
      type="button"
      className="button secondary small"
      disabled={saving}
      onClick={() => setConfirm(true)}
    >
      <Trash2 size={13} />
      Delete {ids.length} empty
    </button>
  );
}
