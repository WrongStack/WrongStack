import { ArrowLeft, Check, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { FileKindIcon } from './FileKindIcon';
import { byteSize, fileKind, fileRowName, parentPath } from './file-model';
import type { FileWorkspaceModel } from './file-workspace-model';

export function FileWorkspaceFolder({ model }: { model: FileWorkspaceModel }) {
  const {
    t,
    setActive,
    folder,
    setFolder,
    setExpanded,
    search,
    treeLoading,
    busy,
    setMenu,
    sort,
    setSort,
    openFile,
    startAction,
    visible,
    setSelected,
    folderLimit,
    setFolderLimit,
    picked,
    setPicked,
    selecting,
    setSelecting,
    setBulk,
    togglePick,
    FOLDER_PAGE,
  } = model;
  return (
    <>
      <div className="file-folder-breadcrumbs">
        <button
          type="button"
          onClick={() => {
            setFolder('');
            setActive('');
          }}
        >
          <FolderOpen size={14} />
          {t('fileView.project')}
        </button>
        {folder
          .split('/')
          .filter(Boolean)
          .map((part, index) => (
            <span key={index}>
              <ChevronRight size={12} />
              <button
                type="button"
                onClick={() =>
                  setFolder(
                    folder
                      .split('/')
                      .slice(0, index + 1)
                      .join('/'),
                  )
                }
              >
                {part}
              </button>
            </span>
          ))}
        <button
          type="button"
          className="button secondary small"
          aria-pressed={selecting}
          onClick={() => {
            setSelecting(!selecting);
            if (selecting) setPicked([]);
          }}
        >
          {selecting ? t('fileView.doneSelecting') : t('fileView.selectItems')}
        </button>
        <select
          aria-label={t('fileView.sort')}
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="name">{t('fileView.column.name')}</option>
          <option value="size">{t('fileView.column.size')}</option>
        </select>
      </div>
      <div className="file-folder-list">
        {picked.length > 0 && (
          <div className="file-bulk-bar" role="toolbar" aria-label={t('fileView.selectedItems')}>
            <span>{t('fileView.selectedCount', { count: picked.length })}</span>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setBulk('move')}
            >
              {t('fileView.moveSelected')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setBulk('copy')}
            >
              {t('fileView.copySelected')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setBulk('rename')}
            >
              {t('fileView.renameSelected')}
            </button>
            <button
              type="button"
              className="button secondary small danger"
              disabled={busy}
              onClick={() => setBulk('delete')}
            >
              {t('fileView.deleteSelected')}
            </button>
            <button type="button" className="button secondary small" onClick={() => setPicked([])}>
              {t('fileView.clearSelection')}
            </button>
          </div>
        )}
        <div className="file-folder-list-heading">
          <span>{t('fileView.column.name')}</span>
          <span>{t('fileView.column.type')}</span>
          <span>{t('fileView.column.size')}</span>
        </div>
        {folder && !search && (
          <button
            type="button"
            className="file-parent-row"
            onClick={() => setFolder(parentPath(folder))}
          >
            <ArrowLeft size={14} />
            {t('fileView.parent')}
          </button>
        )}
        {visible.slice(0, folderLimit).map((node) => (
          <button
            type="button"
            className={`file-folder-row${picked.includes(node.path) ? ' picked' : ''}`}
            key={node.path}
            aria-label={fileRowName(t, node, selecting, Boolean(search))}
            {...(selecting ? { 'aria-pressed': picked.includes(node.path) } : {})}
            onClick={(event) => {
              // Ctrl/Cmd-click picks items without entering selection mode.
              if (selecting || event.ctrlKey || event.metaKey) {
                togglePick(node.path);
                return;
              }
              setSelected(node.path);
              if (node.type === 'directory') {
                setFolder(node.path);
                setExpanded((paths) => [...new Set([...paths, node.path])]);
              } else void openFile(node.path);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                path: node.path,
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <span>
              {picked.includes(node.path) ? (
                <Check size={17} aria-hidden="true" />
              ) : node.type === 'directory' ? (
                <Folder size={17} />
              ) : (
                <FileKindIcon name={node.name} size={17} />
              )}
              <span>
                {node.name} {search && <small>{parentPath(node.path)}</small>}
              </span>
            </span>{' '}
            <span>{fileKind(t, node.path, node.type === 'directory')}</span>{' '}
            <span>{node.size === undefined ? '—' : byteSize(node.size)}</span>
          </button>
        ))}
        {visible.length > folderLimit && (
          <button
            type="button"
            className="file-parent-row"
            onClick={() => setFolderLimit((limit) => limit + FOLDER_PAGE)}
          >
            {t('fileView.showMore', {
              count: Math.min(FOLDER_PAGE, visible.length - folderLimit),
              hidden: visible.length - folderLimit,
            })}
          </button>
        )}
        {!visible.length && !treeLoading && (
          <div className="file-quiet-state">
            <FolderOpen size={30} />
            <h3>{search ? t('fileView.noMatch') : t('fileView.empty')}</h3>
            {!search && (
              <button
                type="button"
                className="button secondary small"
                onClick={() => startAction('file')}
              >
                {t('fileView.createFile')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
