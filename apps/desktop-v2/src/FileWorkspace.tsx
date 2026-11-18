import { FileReviewEmpty } from './FileReviewEmpty';
import { FileWorkspaceActionDialogs } from './FileWorkspaceActionDialogs';
import { FileWorkspaceDocument } from './FileWorkspaceDocument';
import { FileWorkspaceDraftDialogs } from './FileWorkspaceDraftDialogs';
import { FileWorkspaceFolder } from './FileWorkspaceFolder';
import { FileWorkspaceNavigation } from './FileWorkspaceNavigation';
import { FileWorkspaceToolbar } from './FileWorkspaceToolbar';
import { GitHistory } from './GitHistory';
import { ReviewNotesTray } from './ReviewNotesTray';
import { useFileWorkspace } from './useFileWorkspace';
import './file-draft.css';

export function FileWorkspace(props: Parameters<typeof useFileWorkspace>[0]) {
  const model = useFileWorkspace(props);
  const {
    command,
    mode,
    onReview,
    t,
    active,
    busy,
    history,
    setHistory,
    reviewNotes,
    notes,
    changes,
    fromGitPath,
    openFile,
    run,
    save,
    document,
    isDirty,
    setViewerFind,
    review,
  } = model;
  if (history)
    return (
      <GitHistory
        command={command}
        onBack={() => setHistory(false)}
        onOpenFile={(path) => {
          setHistory(false);
          void openFile(fromGitPath(path));
        }}
      />
    );
  return (
    <section
      className={`file-workspace ${mode === 'changes' ? 'file-review-workspace' : ''}`}
      aria-label={mode === 'changes' ? t('fileView.changesLabel') : t('fileView.filesLabel')}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && active) {
          event.preventDefault();
          if (isDirty && !busy) void run(() => save(active));
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'f' &&
          mode === 'files' &&
          document &&
          !document.editing &&
          !document.binary &&
          !document.tooLarge
        ) {
          event.preventDefault();
          setViewerFind((current) => current ?? { lines: [], current: 0 });
        }
      }}
    >
      <FileWorkspaceToolbar model={model} />
      <FileWorkspaceDraftDialogs model={model} />
      <div className="file-workspace-body">
        <FileWorkspaceNavigation model={model} />
        <div className="file-center">
          <FileWorkspaceDocument model={model} />
          {!active &&
            (mode === 'changes' ? (
              <FileReviewEmpty hasChanges={changes.length > 0} />
            ) : (
              <FileWorkspaceFolder model={model} />
            ))}
          {mode === 'changes' && (
            <ReviewNotesTray
              notes={notes}
              busy={reviewNotes.busy}
              ready={reviewNotes.ready}
              error={reviewNotes.error}
              reviewLabel={onReview ? t('fileView.useInConversation') : t('fileView.copyReview')}
              onReload={() => void reviewNotes.store.load()}
              onSave={reviewNotes.store.save}
              onReview={review}
            />
          )}
        </div>
      </div>
      <FileWorkspaceActionDialogs model={model} />
    </section>
  );
}
