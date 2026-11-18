import {
  Check,
  Eye,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  RefreshCw,
  Search,
} from 'lucide-react';
import { FileContentSearch } from './FileContentSearch';
import { fileErrorText } from './file-model';
import type { FileWorkspaceModel } from './file-workspace-model';

export function FileWorkspaceToolbar({ model }: { model: FileWorkspaceModel }) {
  const {
    command,
    mode,
    t,
    folder,
    search,
    setSearch,
    busy,
    error,
    notice,
    setNotice,
    setHistory,
    includeIgnored,
    setIncludeIgnored,
    contentSearch,
    setContentSearch,
    setSearchSelection,
    recoverable,
    changes,
    reload,
    openFile,
    run,
    startAction,
  } = model;
  return (
    <>
      <header className="file-workspace-toolbar">
        <div className="file-workspace-location">
          {mode === 'changes' ? <GitBranch size={16} /> : <FolderOpen size={16} />}
          <strong>
            {mode === 'changes' ? t('fileView.changesTitle') : t('fileView.filesTitle')}
          </strong>
          <span>
            {mode === 'changes'
              ? t('fileView.changedFiles', { count: changes.length })
              : t('fileView.workspace')}
          </span>
        </div>
        <div className="file-workspace-search">
          <Search size={14} />
          <input
            aria-label={t('fileView.searchLabel')}
            placeholder={t('fileView.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {mode === 'files' && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => setContentSearch(true)}
          >
            <Search size={13} />
            {t('fileView.searchContents')}
          </button>
        )}
        <button type="button" className="button secondary small" onClick={() => setHistory(true)}>
          <GitBranch size={13} />
          {t('fileView.history')}
        </button>
        {mode === 'files' ? (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label={t('fileView.newFile')}
              title={t('fileView.newFile')}
              onClick={() => startAction('file')}
            >
              <FilePlus2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('fileView.newFolder')}
              title={t('fileView.newFolder')}
              onClick={() => startAction('directory')}
            >
              <FolderPlus size={16} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button primary small"
            disabled={!changes.some((file) => file['staged']) || busy}
            onClick={() => startAction('commit')}
          >
            <Check size={13} />
            {t('fileView.commitStaged')}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t('fileView.refresh')}
          disabled={busy}
          onClick={() => void run(reload)}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('fileView.showIgnored')}
          title={t('fileView.showIgnoredTitle')}
          aria-pressed={includeIgnored}
          disabled={busy}
          onClick={() => setIncludeIgnored(!includeIgnored)}
        >
          <Eye size={15} />
        </button>
      </header>
      {contentSearch && (
        <FileContentSearch
          command={command}
          folder={folder}
          includeIgnored={includeIgnored}
          onClose={() => setContentSearch(false)}
          onOpen={(path, line) => {
            setContentSearch(false);
            setSearchSelection({ path, line, id: crypto.randomUUID() });
            void openFile(path);
            setNotice(t('fileView.searchMatch', { path, line }));
          }}
        />
      )}
      {error && (
        <p className="file-workspace-error" role="alert">
          {fileErrorText(error, t)}
        </p>
      )}
      {notice && (
        <p className="file-workspace-notice" role="status">
          <Check size={12} />
          {notice}
        </p>
      )}
      {recoverable.length > 0 && (
        <details className="file-draft-recovery">
          <summary>{t('fileView.drafts', { count: recoverable.length })}</summary>
          <p>
            {t('fileView.draftsHelp')}
            {recoverable.length === 500 && ` ${t('fileView.draftsCapped')}`}
          </p>
          {recoverable.map((path) => (
            <button
              key={path}
              type="button"
              className="button secondary"
              onClick={() => void openFile(path)}
            >
              {path}
            </button>
          ))}
        </details>
      )}
    </>
  );
}
