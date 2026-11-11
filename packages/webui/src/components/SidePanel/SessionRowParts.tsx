import { AlertTriangle, FileCode2, GitBranch, Loader2, Wrench } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { SessionHistoryEntry } from '@/stores';
import {
  formatCompactNumber,
  formatRelative,
  formatSessionDuration,
  sessionActivityAt,
} from './session-history.js';

/** Inline name editor shown in place of a history row while renaming it. */
export function SessionRenameField({
  entry,
  renameInput,
  renameDraft,
  setRenameDraft,
  commitRename,
  setRenamingId,
}: {
  entry: SessionHistoryEntry;
  renameInput: React.RefObject<HTMLInputElement | null>;
  renameDraft: string;
  setRenameDraft: (draft: string) => void;
  commitRename: (id: string) => void;
  setRenamingId: (id: string | null) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="min-w-0 px-3 py-3">
      <label
        className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
        htmlFor={`session-name-${entry.id}`}
      >
        {t('activity:sessions.rename', {
          defaultValue: 'Session name',
        })}
      </label>
      <input
        ref={renameInput}
        id={`session-name-${entry.id}`}
        value={renameDraft}
        onChange={(event) => setRenameDraft(event.target.value)}
        onBlur={() => commitRename(entry.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename(entry.id);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setRenamingId(null);
          }
        }}
        placeholder={entry.title || t('activity:sessions.nicknamePlaceholder')}
        className="mt-1 h-8 w-full border border-primary bg-background px-2 text-sm outline-none ring-1 ring-primary"
      />
    </div>
  );
}

/** The row's activity line: last activity (or resuming), duration and counters. */
export function SessionRowStats({
  entry,
  isResuming,
}: {
  entry: SessionHistoryEntry;
  isResuming: boolean;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
      {isResuming ? (
        <span className="inline-flex items-center gap-1 font-sans font-semibold text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('activity:sessions.resuming')}
        </span>
      ) : (
        <span title={new Date(sessionActivityAt(entry)).toLocaleString()}>
          {formatRelative(sessionActivityAt(entry))}
        </span>
      )}
      <span aria-hidden="true">·</span>
      <span>{formatSessionDuration(entry)}</span>
      {entry.tokenTotal > 0 ? <span>{formatCompactNumber(entry.tokenTotal)} tok</span> : null}
      {(entry.messageCount ?? 0) > 0 ? (
        <span>{formatCompactNumber(entry.messageCount ?? 0)} msg</span>
      ) : null}
      {(entry.branchCount ?? 1) > 1 ? (
        <span
          className="inline-flex items-center gap-1 text-primary"
          title={
            entry.activeBranchName
              ? `Active branch: ${entry.activeBranchName} (${entry.branchCount} branches)`
              : `${entry.branchCount} branches`
          }
          data-testid="session-row-branch-badge"
        >
          <GitBranch className="h-3 w-3" />
          {entry.activeBranchName && entry.activeBranchName !== 'main'
            ? `${entry.activeBranchName} (${entry.branchCount})`
            : entry.branchCount}
        </span>
      ) : null}
      {(entry.toolCallCount ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1">
          <Wrench className="h-3 w-3" />
          {entry.toolCallCount}
        </span>
      ) : null}
      {(entry.fileChangeCount ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1">
          <FileCode2 className="h-3 w-3" />
          {entry.fileChangeCount}
        </span>
      ) : null}
      {(entry.toolErrorCount ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {entry.toolErrorCount}
        </span>
      ) : null}
    </div>
  );
}
