'use client';

import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  FileText,
  Folder,
  Image,
  LayoutGrid,
  ListTree,
  PanelLeftClose,
  PanelsTopLeft,
  Paperclip,
  Pin,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FILE_GROUPS, type FileGroup, fileGroup } from '../lib/explorer-view';
import { MAX_PINNED_FILES } from '../lib/file-shelf';
import { useFileShelf } from '../lib/use-file-shelf';
import type { SessionController } from '../lib/use-session';
import { type FileNode, matchingFiles } from '../lib/workspace-model';
import { CodePanel } from './code-panel';
import { FileShelf } from './file-shelf';
import { MarkdownContent } from './markdown-content';
import { usePresentation } from './presentation-mode';
import { EmptyArtwork } from './vibe-visuals';
import { FriendlyIntro, useWorkspacePreferences } from './workspace-preferences';

export function FileBrowser({
  controller,
  onReference,
}: {
  controller: SessionController;
  onReference: () => void;
}) {
  const { state, connection, loadFileTree } = controller;
  const { mode } = usePresentation();
  const { preferences } = useWorkspacePreferences();
  const shelf = useFileShelf(state.cwd);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<FileGroup>('all');
  const [tileChoice, setTiles] = useState<boolean | null>(null);
  const tiles = tileChoice ?? preferences.view !== 'studio';
  const [splitChoice, setSplit] = useState<boolean | null>(null);
  const split = splitChoice ?? preferences.view === 'studio';
  const [filterChoice, setFilters] = useState<boolean | null>(null);
  const filtersOpen = filterChoice ?? preferences.view === 'studio';
  const [copyStatus, setCopyStatus] = useState('');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyOwner = useRef(0);
  const allFiles = useMemo(() => matchingFiles(state.fileTree, ''), [state.fileTree]);
  const matches = useMemo(
    () =>
      allFiles.filter(
        (file) =>
          file.path.toLowerCase().includes(query.trim().toLowerCase()) &&
          (group === 'all' || fileGroup(file.path) === group),
      ),
    [allFiles, query, group],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(FILE_GROUPS).map((kind) => [
          kind,
          kind === 'all'
            ? allFiles.length
            : allFiles.filter((file) => fileGroup(file.path) === kind).length,
        ]),
      ),
    [allFiles],
  );
  useEffect(() => {
    if (
      state.id &&
      connection === 'open' &&
      !state.treeLoaded &&
      !state.treeLoading &&
      !state.treeError
    )
      loadFileTree();
  }, [state.id, connection, state.treeLoaded, state.treeLoading, state.treeError, loadFileTree]);
  const open = (path: string) =>
    controller.openArtifact({
      id: `file:${path}`,
      sessionId: state.id,
      path,
      title: path.split('/').at(-1) || path,
      kind: /\.(png|jpe?g|webp|gif)$/i.test(path) ? 'image' : 'text',
    });
  const preview = state.preview;
  const pinned = Boolean(preview && shelf.data.pinned.includes(preview.artifact.path));
  useEffect(() => {
    if (shelf.ready && preview && !preview.loading && !preview.error)
      shelf.remember(preview.artifact.path);
  }, [shelf.ready, shelf.remember, preview?.artifact.path, preview?.loading, preview?.error]);
  const browseFolder = (path: string) => {
    setQuery(path ? `${path}/` : '');
    setGroup('all');
    controller.closeArtifact();
  };
  const saveCopy = () => {
    if (!preview || preview.loading || preview.error) return;
    try {
      const blobUrl =
        preview.artifact.kind === 'image'
          ? null
          : URL.createObjectURL(new Blob([preview.content], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = blobUrl || preview.content;
      link.download = preview.artifact.path.replaceAll('\\', '/').split('/').at(-1) || 'download';
      document.body.append(link);
      link.click();
      link.remove();
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      setCopyStatus('Could not save a copy. Try again from your browser.');
    }
  };
  const lineCount = useMemo(
    () => (preview?.content ? preview.content.split('\n').length : 0),
    [preview?.content],
  );
  useEffect(() => {
    copyOwner.current++;
    setCopyStatus('');
    return () => {
      copyOwner.current++;
      clearTimeout(copyTimer.current);
    };
  }, [preview?.artifact.path]);
  const copyFile = async () => {
    if (!preview || preview.loading || preview.error) return;
    const owner = copyOwner.current;
    try {
      await navigator.clipboard.writeText(preview.content);
      if (owner !== copyOwner.current) return;
      setCopyStatus('Copied file contents.');
    } catch {
      if (owner !== copyOwner.current) return;
      setCopyStatus('Could not copy. Select the text to copy it manually.');
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus(''), 4000);
  };
  const previewBody = preview && (
    <>
      <nav className="file-breadcrumbs" aria-label="File location">
        <button type="button" onClick={() => browseFolder('')}>
          <Folder size={13} /> Project
        </button>
        {preview.artifact.path
          .replaceAll('\\', '/')
          .split('/')
          .slice(0, -1)
          .map((part, index, parts) => (
            <span key={`${index}:${part}`}>
              <ChevronRight size={11} />
              <button
                type="button"
                onClick={() => browseFolder(parts.slice(0, index + 1).join('/'))}
              >
                {part}
              </button>
            </span>
          ))}
        <ChevronRight size={11} />
        <span className="file-breadcrumb-current">{preview.artifact.title}</span>
      </nav>
      <div className="file-preview-meta">
        <span>
          {preview.artifact.kind === 'image'
            ? 'Image preview'
            : mode === 'simple' && /\.md$/i.test(preview.artifact.path)
              ? 'Markdown preview'
              : mode === 'simple' && /\.html?$/i.test(preview.artifact.path)
                ? 'HTML preview'
                : 'Source'}
        </span>
        <span>Read only</span>
        <button
          type="button"
          className="file-pin-toggle"
          aria-label={pinned ? 'Unpin this file' : 'Pin this file'}
          aria-pressed={pinned}
          disabled={
            !shelf.ready ||
            preview.loading ||
            Boolean(preview.error) ||
            (!pinned && shelf.data.pinned.length >= MAX_PINNED_FILES)
          }
          title={
            !pinned && shelf.data.pinned.length >= MAX_PINNED_FILES
              ? 'Unpin one of your 8 handy files to make room.'
              : pinned
                ? 'Remove this shortcut'
                : 'Keep a shortcut in this project'
          }
          onClick={() => shelf.togglePin(preview.artifact.path)}
        >
          <Pin size={12} />
          {pinned ? 'Kept handy' : 'Keep handy'}
        </button>
        {mode === 'extended' &&
          !preview.loading &&
          !preview.error &&
          preview.artifact.kind !== 'image' && (
            <span>
              {lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'} ·{' '}
              {preview.content.length.toLocaleString()} characters
            </span>
          )}
      </div>
      {copyStatus && (
        <p className="fine-print" role="status">
          {copyStatus}
        </p>
      )}
      {preview.loading ? (
        <p className="panel-hint" role="status">
          Loading file…
        </p>
      ) : preview.error ? (
        <p className="form-error" role="alert">
          {preview.error}
        </p>
      ) : preview.artifact.kind === 'image' ? (
        <img className="file-preview-image" src={preview.content} alt={preview.artifact.title} />
      ) : /\.html?$/i.test(preview.artifact.path) && mode === 'simple' ? (
        <iframe
          className="html-preview"
          title={`Preview ${preview.artifact.title}`}
          sandbox=""
          srcDoc={preview.content}
        />
      ) : /\.md$/i.test(preview.artifact.path) && mode === 'simple' ? (
        <MarkdownContent text={preview.content} basePath={preview.artifact.path} />
      ) : (
        <CodePanel
          value={preview.content}
          label="Source"
          language={preview.artifact.path}
          className="source-preview"
        />
      )}
    </>
  );
  return (
    <div
      className="file-manager"
      data-selected={Boolean(preview)}
      data-layout={split ? 'split' : 'single'}
    >
      <FriendlyIntro id="files" label="files">
        <span className="explorer-intro-icon">
          <Folder size={24} />
        </span>
        <div>
          <h2>Your project, within reach</h2>
          <p>Find a file, take a look, or add it to your next message.</p>
        </div>
        <span className="explorer-count">
          {state.treeLoaded
            ? `${allFiles.length.toLocaleString()} files in this project`
            : 'Reading your project…'}
        </span>
      </FriendlyIntro>
      <button
        type="button"
        className="explorer-filter-toggle"
        aria-expanded={filtersOpen}
        aria-controls="file-type-filters"
        onClick={() => setFilters(!filtersOpen)}
      >
        <Search size={13} />
        {group === 'all' ? 'Find by file type' : FILE_GROUPS[group]}
        <ChevronRight size={13} />
      </button>
      <fieldset
        hidden={!filtersOpen}
        id="file-type-filters"
        className="explorer-filters file-type-filters"
        aria-label="File types"
      >
        {(Object.entries(FILE_GROUPS) as [FileGroup, string][]).map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={group === key}
            onClick={() => setGroup(key)}
          >
            <FileKindIcon group={key} />
            <span>{label}</span>
            <small>{state.treeLoaded ? counts[key] : '—'}</small>
          </button>
        ))}
      </fieldset>
      <FileShelf shelf={shelf} offline={connection !== 'open'} onOpen={open} />
      <div className="files-layout" data-selected={Boolean(preview)}>
        <aside className="files-directory" aria-label="Directories and files">
          <div className="panel-section-heading">
            <h2>Project files</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh project files"
              disabled={state.treeLoading || connection !== 'open'}
              onClick={loadFileTree}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <label className="file-search">
            <Search size={14} />
            <input
              aria-label="Search project files"
              placeholder="Find a file…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="explorer-list-heading">
            <span>{query || group !== 'all' ? `${matches.length} matches` : 'Folder view'}</span>
            <div className="file-layout-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={split ? 'Use single file view' : 'Use split file view'}
                title={split ? 'One thing at a time' : 'Browse and read side by side'}
                onClick={() => setSplit(!split)}
              >
                {split ? <PanelLeftClose size={14} /> : <PanelsTopLeft size={14} />}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Show file cards"
                title="Show file cards"
                aria-pressed={tiles}
                onClick={() => setTiles(!tiles)}
              >
                {tiles ? <ListTree size={14} /> : <LayoutGrid size={14} />}
              </button>
            </div>
          </div>
          {(query || group !== 'all') && (
            <button
              type="button"
              className="text-button explorer-reset"
              onClick={() => {
                setQuery('');
                setGroup('all');
              }}
            >
              Clear search and filters
            </button>
          )}
          {state.treeLoading && (
            <p className="panel-hint" role="status">
              Reading the project…
            </p>
          )}
          {state.treeError && (
            <p className="form-error" role="alert">
              {state.treeError}
            </p>
          )}
          <nav
            className="file-tree"
            data-view={tiles ? 'cards' : 'tree'}
            aria-label="Project file tree"
          >
            {query || group !== 'all' || tiles
              ? matches.slice(0, 100).map((node) => (
                  <button
                    type="button"
                    aria-current={preview?.artifact.path === node.path ? 'true' : undefined}
                    className="tree-row"
                    aria-label={node.path}
                    title={node.path}
                    key={node.path}
                    disabled={connection !== 'open'}
                    onClick={() => open(node.path)}
                  >
                    <FileKindIcon group={fileGroup(node.path)} />
                    <span>{tiles ? node.name : node.path}</span>
                    {tiles && <small>{FILE_GROUPS[fileGroup(node.path)]}</small>}
                  </button>
                ))
              : state.fileTree.map((node) => (
                  <TreeBranch
                    key={node.path}
                    node={node}
                    depth={0}
                    selected={preview?.artifact.path || ''}
                    onOpen={open}
                    disabled={connection !== 'open'}
                  />
                ))}
          </nav>
          {!state.treeLoading && state.treeLoaded && !matches.length && (
            <p className="panel-hint">
              {query || group !== 'all'
                ? 'No files match this search. Try another type or clear the filters.'
                : 'No project files found.'}
            </p>
          )}
          {(query || group !== 'all' || tiles) && matches.length > 100 && (
            <p className="panel-hint">
              Showing the first 100 of {matches.length} matches. Narrow your search.
            </p>
          )}
        </aside>
        {!preview && (
          <section className="file-content file-empty">
            <EmptyArtwork kind="files" />
            <h3>Choose a file</h3>
            <p>
              Select a project file from the directory on the right.
              <br />
              Looking for something visual? Browse images or documents first.
            </p>
            <div className="file-discovery-cards">
              {(['documents', 'images'] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  onClick={() => {
                    setQuery('');
                    setGroup(kind);
                    setTiles(true);
                  }}
                >
                  <FileKindIcon group={kind} />
                  <strong>Browse {kind}</strong>
                  <span>
                    {counts[kind]} {kind} in this project <ChevronRight size={13} />
                  </span>
                </button>
              ))}
            </div>
            <div className="explorer-tip">
              <Paperclip size={15} />
              <span>“Add to message” gives your assistant the file as context.</span>
            </div>
          </section>
        )}
        {preview && (
          <section className="file-content artifact-preview file-preview">
            <div className="panel-section-heading">
              <button
                type="button"
                className="secondary-button file-back"
                aria-label="Browse files"
                onClick={controller.closeArtifact}
              >
                <ArrowLeft size={14} /> Files
              </button>
              <h3 title={preview.artifact.title}>{preview.artifact.title}</h3>
              <div>
                <button
                  type="button"
                  className="icon-button file-reader-layout"
                  aria-label={split ? 'Use single file view' : 'Use split file view'}
                  title="Change file view"
                  onClick={() => setSplit(!split)}
                >
                  {split ? <PanelLeftClose size={14} /> : <PanelsTopLeft size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Save a copy"
                  title="Save a copy to your device"
                  disabled={preview.loading || Boolean(preview.error)}
                  onClick={saveCopy}
                >
                  <Download size={14} />
                </button>
                {preview.artifact.kind !== 'image' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Copy file contents"
                    title="Copy file contents"
                    disabled={preview.loading || Boolean(preview.error)}
                    onClick={() => void copyFile()}
                  >
                    {copyStatus === 'Copied file contents.' ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button file-reference-action"
                  aria-label="Reference in message"
                  title="Add file to your next message"
                  onClick={() => {
                    controller.referenceFile(preview.artifact.path);
                    onReference();
                  }}
                >
                  <Paperclip size={14} />
                  <span>Add to message</span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close selected file"
                  onClick={controller.closeArtifact}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {previewBody}
          </section>
        )}
      </div>
    </div>
  );
}

function FileKindIcon({ group }: { group: FileGroup }) {
  const Icon =
    group === 'images'
      ? Image
      : group === 'documents'
        ? FileText
        : group === 'all'
          ? Folder
          : FileCode2;
  return <Icon size={17} className={`file-kind-icon file-kind-${group}`} aria-hidden="true" />;
}

function TreeBranch({
  node,
  depth,
  selected,
  onOpen,
  disabled,
}: {
  node: FileNode;
  depth: number;
  selected: string;
  onOpen: (path: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const directory = node.type === 'directory';
  return (
    <div>
      <button
        type="button"
        aria-expanded={directory ? open : undefined}
        aria-current={!directory && selected === node.path ? 'true' : undefined}
        className={`tree-row ${open ? 'expanded' : ''}`}
        style={{ paddingLeft: 7 + depth * 13 }}
        disabled={disabled}
        onClick={() => (directory ? setOpen((value) => !value) : onOpen(node.path))}
      >
        {directory ? (
          <>
            <ChevronRight size={11} />
            <Folder size={14} />
          </>
        ) : (
          <FileKindIcon group={fileGroup(node.path)} />
        )}
        <span title={node.path}>{node.name}</span>
      </button>
      {directory && open && (
        <div className="tree-group">
          {node.children.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onOpen={onOpen}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
