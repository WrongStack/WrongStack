import { ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
  const untitled = t('historyView.untitled');
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <header className="history-selection">
      <span className="eyebrow">{t('historyView.selection.eyebrow')}</span>
      <h2>{historyTitle(row, owner, untitled)}</h2>
      <p>
        {String(row['provider'])} / {String(row['model'])} ·{' '}
        {t('historyView.selection.started', {
          time: recoveryDate(row['startedAt'], t('recovery.timeMissing')),
        })}
        {Number(row['branchCount'] ?? 0) > 1
          ? ` · ⎇ ${String(row['branchCount'])} branches${
              row['activeBranchName'] ? ` (active: ${String(row['activeBranchName'])})` : ''
            }`
          : ''}
      </p>
      <div>
        <CopyButton text={selected} label={t('historyView.selection.copyId')} />
        <button
          type="button"
          className="button secondary small"
          disabled={busy || saving}
          onClick={() => onRename(row)}
        >
          <Pencil size={13} />
          {t('historyView.selection.rename')}
        </button>
        {owner && (
          <button type="button" className="button primary small" onClick={() => onOpen(owner)}>
            {t('historyView.selection.openDesktop')}
            <ArrowRight size={13} />
          </button>
        )}
        {!owner && (
          <button
            type="button"
            className="button primary small"
            onClick={() =>
              onRestore({
                id: selected,
                title: historyTitle(row, undefined, untitled),
                mode: 'resume',
              })
            }
          >
            {t('historyView.selection.resume')}
          </button>
        )}
        <button
          type="button"
          className="button secondary small"
          onClick={() =>
            onRestore({ id: selected, title: historyTitle(row, owner, untitled), mode: 'fork' })
          }
        >
          {t('historyView.selection.fork')}
        </button>
        {!owner && !confirmDelete && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy || saving}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={13} />
            {t('historyView.selection.delete')}
          </button>
        )}
      </div>
      {confirmDelete && !owner && (
        <div className="history-delete-confirm" role="alert">
          <p>
            {t('historyView.selection.deleteAsk', {
              title: historyTitle(row, undefined, untitled),
            })}
          </p>
          <button
            type="button"
            className="button danger small"
            disabled={saving}
            onClick={() => void onDelete([selected]).finally(() => setConfirmDelete(false))}
          >
            {t('historyView.selection.deleteConfirm')}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirmDelete(false)}
          >
            {t('historyView.selection.keep')}
          </button>
        </div>
      )}
      <p className="field-help">
        {owner ? t('historyView.selection.ownerHelp') : t('historyView.selection.readOnlyHelp')}{' '}
        {t('historyView.selection.fileLinks')}
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
  const { t } = useDesktopText();
  const [confirm, setConfirm] = useState(false);
  if (!ids.length) return null;
  return confirm ? (
    <span className="history-delete-confirm" role="alert">
      {t(ids.length === 1 ? 'historyView.empty.askOne' : 'historyView.empty.askMany', {
        n: ids.length,
      })}
      <button
        type="button"
        className="button danger small"
        disabled={saving}
        onClick={() => void onDelete(ids).finally(() => setConfirm(false))}
      >
        {t('historyView.empty.confirm')}
      </button>
      <button type="button" className="button secondary small" onClick={() => setConfirm(false)}>
        {t('historyView.selection.keep')}
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
      {t('historyView.empty.offer', { n: ids.length })}
    </button>
  );
}
