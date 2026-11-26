import { PanelLeftOpen } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';
import { FileReviewEmpty } from './FileReviewEmpty';
import { FileWorkspaceActionDialogs } from './FileWorkspaceActionDialogs';
import { FileWorkspaceDocument } from './FileWorkspaceDocument';
import { FileWorkspaceDraftDialogs } from './FileWorkspaceDraftDialogs';
import { FileWorkspaceFolder } from './FileWorkspaceFolder';
import { FileWorkspaceNavigation } from './FileWorkspaceNavigation';
import { FileWorkspaceToolbar } from './FileWorkspaceToolbar';
import { GitHistory } from './GitHistory';
import { usePaneLayout } from './pane-layout-context';
import { ReviewNotesTray } from './ReviewNotesTray';
import { useFileWorkspace } from './useFileWorkspace';
import './file-draft.css';
import './file-tree-collapse.css';

export function FileWorkspace(props: Parameters<typeof useFileWorkspace>[0]) {
  const model = useFileWorkspace(props);
  const paneLayout = usePaneLayout();
  const fileTree = paneLayout?.panes.fileTree;
  // The saved pane layout owns collapse and width when the App provider is
  // present; standalone fixtures keep the per-window fallback state.
  const treeCollapsed = paneLayout && fileTree ? !fileTree.open : model.treeCollapsed;
  const setTreeCollapsed: Dispatch<SetStateAction<boolean>> =
    paneLayout && fileTree
      ? (collapsed) => {
          // Collapse callers pass plain booleans; the layout stores open state.
          if (typeof collapsed !== 'boolean') return;
          paneLayout.setOpen('fileTree', !collapsed);
        }
      : model.setTreeCollapsed;
  const view = { ...model, treeCollapsed, setTreeCollapsed };
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
    treePanelId,
  } = view;
  const reopenControl = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Collapsing unmounts the header control, so keyboard focus moves to the reopen control.
    if (treeCollapsed) reopenControl.current?.focus();
  }, [treeCollapsed]);
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
      <FileWorkspaceToolbar model={view} />
      <FileWorkspaceDraftDialogs model={view} />
      <div className={`file-workspace-body${treeCollapsed ? ' tree-collapsed' : ''}`}>
        {treeCollapsed && (
          <div className="file-tree-rail">
            <button
              type="button"
              ref={reopenControl}
              title={t('fileView.explorerTab')}
              aria-expanded={false}
              aria-controls={treePanelId}
              onClick={() => setTreeCollapsed(false)}
            >
              <PanelLeftOpen size={14} />
              <span>{t('fileView.explorerTab')}</span>
            </button>
          </div>
        )}
        <FileWorkspaceNavigation
          model={view}
          pane={
            paneLayout && fileTree?.open
              ? {
                  width: fileTree.width,
                  onResize: (width) => paneLayout.setWidth('fileTree', width),
                }
              : undefined
          }
        />
        <div className="file-center">
          <FileWorkspaceDocument model={view} />
          {!active &&
            (mode === 'changes' ? (
              <FileReviewEmpty hasChanges={changes.length > 0} />
            ) : (
              <FileWorkspaceFolder model={view} />
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
      <FileWorkspaceActionDialogs model={view} />
    </section>
  );
}
