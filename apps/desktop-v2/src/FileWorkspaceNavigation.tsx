import { FileDiff, LayoutList, LoaderCircle, PanelLeftClose } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { FileChangeCounts, StageAllButton } from './FileChangeCounts';
import { FileExplorerFooter } from './FileExplorerChrome';
import { FileTreeView } from './FileTreeView';
import { fileName, parentPath } from './file-model';
import type { FileWorkspaceModel } from './file-workspace-model';
import { PaneSplitter } from './PaneSplitter';
import { paneBounds } from './pane-layout';

export function FileWorkspaceNavigation({
  model,
  pane,
}: {
  model: FileWorkspaceModel;
  /** Present when the saved pane layout controls the tree; width applies via CSS. */
  pane?: { width: number; onResize: (width: number) => void } | undefined;
}) {
  const {
    mode,
    t,
    tree,
    git,
    active,
    setActive,
    setFolder,
    expanded,
    setExpanded,
    search,
    treeLoading,
    busy,
    setError,
    setNotice,
    setMenu,
    includeIgnored,
    all,
    prefix,
    changes,
    fromGitPath,
    openFile,
    stage,
    selected,
    setSelected,
    treeCollapsed,
    setTreeCollapsed,
    treePanelId,
  } = model;
  const panelTitle = mode === 'files' ? t('fileView.explorer') : t('fileView.sourceControl');
  const collapseButton = useRef<HTMLButtonElement>(null);
  const wasCollapsed = useRef(treeCollapsed);
  useEffect(() => {
    // After reopening from the rail, hand focus back to this header control.
    if (wasCollapsed.current && !treeCollapsed) collapseButton.current?.focus();
    wasCollapsed.current = treeCollapsed;
  }, [treeCollapsed]);
  return (
    <aside
      id={treePanelId}
      className="file-navigation"
      data-pane-width={pane ? pane.width : undefined}
      style={pane ? { ['--file-tree-width' as string]: `${pane.width}px` } : undefined}
    >
      <header>
        <span>{panelTitle}</span>
        <span className="file-navigation-actions">
          {mode === 'files' && (
            <button
              type="button"
              aria-label={t('fileView.collapseAll')}
              onClick={() => setExpanded([])}
            >
              <LayoutList size={13} />
            </button>
          )}
          <button
            type="button"
            ref={collapseButton}
            aria-label={panelTitle}
            title={panelTitle}
            aria-expanded={!treeCollapsed}
            aria-controls={treePanelId}
            onClick={() => setTreeCollapsed(true)}
          >
            <PanelLeftClose size={13} />
          </button>
        </span>
      </header>
      {treeLoading ? (
        <div className="file-quiet-state">
          <LoaderCircle size={16} className="spin" />
          {t('fileView.reading')}
        </div>
      ) : mode === 'files' ? (
        <FileTreeView
          tree={tree}
          expanded={expanded}
          active={active}
          selected={selected}
          query={search}
          changes={changes}
          prefix={prefix}
          onSelect={(node) => {
            setSelected(node.path);
            if (node.type === 'file') void openFile(node.path);
            else {
              setFolder(node.path);
              setActive('');
              setExpanded((paths) =>
                paths.includes(node.path)
                  ? paths.filter((p) => p !== node.path)
                  : [...paths, node.path],
              );
            }
          }}
          onContext={(event, path) => {
            event.preventDefault();
            setMenu({
              path,
              x: event.clientX,
              y: event.clientY,
            });
          }}
        />
      ) : (
        <div className="file-change-list">
          {typeof git['error'] === 'string' ? (
            <p className="file-quiet-state">{String(git['error'])}</p>
          ) : (
            ['Working tree', 'Staged'].map((group) => {
              const rows = changes.filter(
                (file) =>
                  Boolean(file['staged']) === (group === 'Staged') &&
                  String(file['path']).toLowerCase().includes(search.toLowerCase()),
              );
              return (
                <section key={group}>
                  <h3>
                    {group === 'Staged' ? t('fileView.staged') : t('fileView.workingTree')}
                    <span>{rows.length}</span>
                    <StageAllButton
                      staged={group === 'Staged'}
                      shown={rows.length > 0 && !search}
                      busy={busy}
                      onClick={() => void stage(null, group === 'Staged')}
                    />
                  </h3>
                  {rows.map((file) => (
                    <div
                      className={`file-change-row ${active === fromGitPath(String(file['path'])) ? 'selected' : ''}`}
                      key={String(file['path'])}
                    >
                      <button
                        type="button"
                        title={t('fileView.reviewPath', { path: String(file['path']) })}
                        onClick={() => {
                          const path = fromGitPath(String(file['path']));
                          if (file['status'] === 'U' || file['status'] === 'D') {
                            setActive(path);
                            setError('');
                            setNotice('');
                          } else void openFile(path);
                        }}
                      >
                        <FileDiff size={14} />
                        <span>
                          {/* Git lists an untracked folder with a trailing slash; its name is
                                  the last segment before it. */}
                          <strong>{fileName(gitRowPath(file['path']))}</strong>
                          <small>
                            <FileChangeCounts added={file['added']} deleted={file['deleted']} />
                            {typeof file['origPath'] === 'string' && file['origPath']
                              ? t(
                                  file['status'] === 'C'
                                    ? 'fileView.copiedFrom'
                                    : 'fileView.renamedFrom',
                                  { path: file['origPath'] },
                                )
                              : parentPath(gitRowPath(file['path'])) || t('fileView.projectRoot')}
                          </small>
                        </span>
                        <b
                          className={`file-git-status status-${String(file['status']).replace('?', 'untracked')}`}
                        >
                          {String(file['status'])}
                        </b>
                      </button>
                      <button
                        type="button"
                        className="file-stage-row"
                        aria-label={t(
                          file['staged'] ? 'fileView.unstagePath' : 'fileView.stagePath',
                          {
                            path: String(file['path']),
                          },
                        )}
                        disabled={busy}
                        onClick={() =>
                          void stage(fromGitPath(String(file['path'])), Boolean(file['staged']))
                        }
                      >
                        {file['staged'] ? '−' : '+'}
                      </button>
                    </div>
                  ))}
                </section>
              );
            })
          )}
          {!changes.length && !git['error'] && (
            <p className="file-quiet-state">{t('fileView.noChanges')}</p>
          )}
        </div>
      )}
      {mode === 'files' && (
        <FileExplorerFooter
          count={all.filter((n) => n.type === 'file').length}
          includeIgnored={includeIgnored}
        />
      )}
      {pane && (
        <PaneSplitter
          label={panelTitle}
          controls={treePanelId}
          side="left"
          width={pane.width}
          min={paneBounds.fileTree.min}
          max={paneBounds.fileTree.max}
          onResize={pane.onResize}
        />
      )}
    </aside>
  );
}

/** A source-control row's path without the trailing slash Git puts on an untracked folder. */
function gitRowPath(path: unknown): string {
  return String(path).replace(/\/+$/, '');
}
