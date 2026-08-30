import {
  Check,
  File,
  FileEdit,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  Search,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';
import { type SocketRequestHandle, socketRequest } from './lib/socket-request.js';
import type { SimpleSocket } from './lib/ws.js';

const SELECTED_FILE_STORAGE_KEY = 'wrongstack-simpleui-file-manager-selected-file';
const MAX_STORED_PATH_LENGTH = 4096;

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface FileExplorerProps {
  socketRef: React.RefObject<SimpleSocket | null>;
}

function readSelectedPath(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(SELECTED_FILE_STORAGE_KEY);
    return stored && stored.length <= MAX_STORED_PATH_LENGTH ? stored : null;
  } catch {
    return null;
  }
}

function persistSelectedPath(path: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_FILE_STORAGE_KEY, path);
  } catch {
    // Persistence is best-effort in private browsing and quota-restricted environments.
  }
}

function isPathInsideDirectory(filePath: string | null, directoryPath: string): boolean {
  if (!filePath) return false;
  const file = filePath.replaceAll('\\', '/');
  const directory = directoryPath.replaceAll('\\', '/').replace(/\/+$/, '');
  return file.startsWith(`${directory}/`);
}

function nodeOrDescendantMatches(node: FileNode, filterLower: string): boolean {
  if (node.name.toLowerCase().includes(filterLower)) return true;
  if (node.children) {
    return node.children.some((child) => nodeOrDescendantMatches(child, filterLower));
  }
  return false;
}

function FileTreeNode({
  node,
  depth,
  onSelect,
  selectedPath,
  filter,
}: {
  node: FileNode;
  depth: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  filter: string;
}) {
  const [expanded, setExpanded] = useState(() => isPathInsideDirectory(selectedPath, node.path));
  const hasChildren = node.type === 'directory' && node.children && node.children.length > 0;
  const isSelected = node.type === 'file' && node.path === selectedPath;

  // When a persisted selection is restored, reveal its ancestor chain the
  // next time the otherwise-collapsed file list is opened.
  useEffect(() => {
    if (node.type === 'directory' && isPathInsideDirectory(selectedPath, node.path)) {
      setExpanded(true);
    }
  }, [node.path, node.type, selectedPath]);

  // Auto-expand to reveal matching search results
  useEffect(() => {
    if (filter && depth === 0) {
      setExpanded(true);
    }
  }, [filter, depth]);

  // Skip hidden directories in the root
  if (depth === 0 && node.type === 'directory' && node.name.startsWith('.')) {
    return null;
  }

  const filterLower = filter.toLowerCase();
  const nameMatch = filter && node.name.toLowerCase().includes(filterLower);
  const childMatch =
    filter &&
    node.children?.some((c) => nodeOrDescendantMatches(c, filterLower));

  if (filter && !nameMatch && !childMatch && depth > 0) return null;

  return (
    <>
      <button
        type="button"
        className={`file-tree-node${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => {
          if (node.type === 'directory') setExpanded((v) => !v);
          else onSelect(node.path);
        }}
      >
        {node.type === 'directory' ? (
          hasChildren ? (
            expanded ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />
          ) : (
            <span style={{ width: 11 }} />
          )
        ) : (
          <span style={{ width: 11 }} />
        )}
        {node.type === 'directory' ? (
          expanded ? <FolderOpen size={12} aria-hidden="true" /> : <Folder size={12} aria-hidden="true" />
        ) : (
          <File size={12} aria-hidden="true" />
        )}
        <span title={node.path}>{node.name}</span>
      </button>
      {expanded && hasChildren && node.children?.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          onSelect={onSelect}
          selectedPath={selectedPath}
          filter={filter}
        />
      ))}
    </>
  );
}

// ── Inline SVG icons used inside the component tree ──────────────

function ChevronDown({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronRight({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function FileExplorer({ socketRef }: FileExplorerProps) {
  const [open, setOpen] = useState(false);
  const [fileListOpen, setFileListOpen] = useState(false);
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(readSelectedPath);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);
  // In-flight tree/content/save requests. A new request (or an unmount)
  // cancels the previous one so a stale timer can't later fire setState
  // against fresh or unmounted state.
  const pendingTreeRef = useRef<SocketRequestHandle | null>(null);
  const pendingContentRef = useRef<SocketRequestHandle | null>(null);
  const pendingSaveRef = useRef<SocketRequestHandle | null>(null);
  const savedBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      pendingTreeRef.current?.cancel();
      pendingContentRef.current?.cancel();
      pendingSaveRef.current?.cancel();
      if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isEditing) {
          setIsEditing(false);
          setEditedContent(null);
        } else {
          setOpen(false);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isEditing]);

  const loadTree = useCallback(() => {
    setLoading(true);
    setError(null);
    const socket = socketRef.current;
    if (!socket) { setLoading(false); return; }

    pendingTreeRef.current?.cancel();
    const handle = socketRequest({ socket, sendType: 'files.tree', payload: {}, expectType: 'files.tree' });
    pendingTreeRef.current = handle;
    void handle.promise.then((payload) => {
      if (pendingTreeRef.current !== handle) return;
      pendingTreeRef.current = null;
      setLoading(false);
      if (!payload) return; // timed out — empty tree renders the failure note
      if (Array.isArray(payload['tree'])) {
        setTree(payload['tree'] as FileNode[]);
      } else {
        setError('Failed to load file tree.');
      }
    });
  }, [socketRef]);

  const loadFileContent = useCallback((filePath: string) => {
    setContentLoading(true);
    setError(null);
    setFileContent(null);
    setEditedContent(null);
    setIsEditing(false);
    setSaved(false);

    const socket = socketRef.current;
    if (!socket) { setContentLoading(false); return; }

    pendingContentRef.current?.cancel();
    const handle = socketRequest({
      socket,
      sendType: 'files.read',
      payload: { filePath },
      expectType: 'files.read',
      accept: (frame) => {
        const returned = frame.payload as { filePath?: unknown } | undefined;
        return returned?.filePath === filePath;
      },
    });
    pendingContentRef.current = handle;
    void handle.promise.then((payload) => {
      if (pendingContentRef.current !== handle) return;
      pendingContentRef.current = null;
      setContentLoading(false);
      if (!payload) return; // timed out — null content renders the failure note
      if (typeof payload['content'] === 'string') {
        setFileContent(payload['content']);
        setEditedContent(null);
      } else {
        setFileContent(null);
        setError(payload['error'] ? String(payload['error']) : 'Failed to read file.');
      }
    });
  }, [socketRef]);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    persistSelectedPath(path);
    loadFileContent(path);
  }, [loadFileContent]);

  const handleSave = useCallback(() => {
    if (!selectedPath || editedContent == null) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    const socket = socketRef.current;
    if (!socket) { setSaving(false); return; }

    if (savedBadgeTimerRef.current) {
      clearTimeout(savedBadgeTimerRef.current);
      savedBadgeTimerRef.current = null;
    }
    pendingSaveRef.current?.cancel();
    const handle = socketRequest({
      socket,
      sendType: 'files.write',
      payload: { filePath: selectedPath, content: editedContent },
      expectType: 'files.written',
      accept: (frame) => {
        const returned = frame.payload as { filePath?: unknown } | undefined;
        return returned?.filePath === selectedPath;
      },
    });
    pendingSaveRef.current = handle;
    void handle.promise.then((payload) => {
      if (pendingSaveRef.current !== handle) return;
      pendingSaveRef.current = null;
      setSaving(false);
      if (!payload) {
        setError('Failed to save file (timed out).');
        return;
      }
      if (payload['success']) {
        setFileContent(editedContent);
        setEditedContent(null);
        setIsEditing(false);
        setSaved(true);
        savedBadgeTimerRef.current = setTimeout(() => {
          setSaved(false);
          savedBadgeTimerRef.current = null;
        }, 2000);
      } else {
        setError(payload['error'] ? String(payload['error']) : 'Failed to save file.');
      }
    });
  }, [selectedPath, editedContent, socketRef]);

  const handleTreeReload = useCallback(() => {
    setTree(null);
    loadTree();
  }, [loadTree]);

  const openExplorer = useCallback(() => {
    setOpen(true);
    setFileListOpen(false);
    if (!tree) loadTree();
    if (selectedPath && fileContent === null && !contentLoading) {
      loadFileContent(selectedPath);
    }
  }, [tree, selectedPath, fileContent, contentLoading, loadTree, loadFileContent]);

  useEffect(() => {
    const onOpen = () => openExplorer();
    return onSimplePanel('open-file-explorer', onOpen);
  }, [openExplorer]);

  // ── Tab key handling — insert 2 spaces instead of changing focus ──
  // These hooks must live before the `if (!open)` early return so React's
  // hook ordering stays stable across renders.
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const current = editedContent ?? fileContent ?? '';
        const newValue = current.slice(0, start) + '  ' + current.slice(end);
        setEditedContent(newValue);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
      // Ctrl+S / Cmd+S → save
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving) handleSave();
      }
    },
    [editedContent, fileContent, saving, handleSave],
  );

  // ── Sync scroll position between textarea and highlight overlay ──
  const syncScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const pre = ta.previousElementSibling as HTMLElement | null;
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }, []);

  // Open the panel — load tree on first open
  if (!open) {
    return (
      <button
        type="button"
        className="file-explorer-trigger"
        aria-label="Open file manager"
        title="Project file manager"
        onClick={openExplorer}
      >
        <Folder size={13} aria-hidden="true" />
      </button>
    );
  }

  const content = isEditing ? (editedContent ?? fileContent ?? '') : (fileContent ?? '');
  const fileName = selectedPath?.split(/[\\/]/).pop() ?? '';

  // ── Syntax highlighting overlay ─────────────────────────────────────
  // Lightweight token-based highlighter — wraps keywords, strings, comments,
  // and numbers in <span> elements with CSS classes. Not a full parser, but
  // enough to make code readable behind the transparent textarea. Returns
  // React nodes so the raw file text is escaped by React itself — no HTML
  // string is ever injected into the document.
  const CODE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss',
    'html', 'xml', 'svg', 'py', 'rs', 'go', 'rb', 'java', 'c', 'cpp',
    'h', 'sh', 'bash', 'yml', 'yaml', 'sql', 'md', 'graphql',
  ]);

  const TOKEN_PATTERN =
    /(\/\/[^\n]*|#[^\n]*)|("[^"\n]*"|'[^'\n]*'|`[^`]*`)|(\b\d+\.?\d*\b)|(\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|extends|implements|import|export|from|default|async|await|new|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|interface|type|enum|public|private|protected|static|readonly|abstract|namespace|declare|module|def|elif|fn|struct|impl|pub|use|match|package|func|val|nil)\b)/g;

  function highlightContent(text: string): React.ReactNode {
    if (!text) return null;
    const ext = selectedPath?.split('.').pop()?.toLowerCase() ?? '';
    if (!CODE_EXTENSIONS.has(ext)) return text;

    const pattern = new RegExp(TOKEN_PATTERN.source, 'g');
    const nodes: React.ReactNode[] = [];
    let last = 0;
    let key = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      const className = match[1]
        ? 'hl-comment'
        : match[2]
          ? 'hl-string'
          : match[3]
            ? 'hl-number'
            : 'hl-keyword';
      nodes.push(
        <span key={`hl-${key++}`} className={className}>
          {match[0]}
        </span>,
      );
      last = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  return (
    <>
      <button type="button" className="settings-overlay" tabIndex={-1} onClick={() => setOpen(false)} />
      <aside
        className="file-explorer file-manager"
        role="dialog"
        aria-modal="true"
        aria-label="File manager"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="file-explorer-head">
          <span><Folder size={13} aria-hidden="true" /> FILES</span>
          <div className="file-explorer-head-actions">
            <button
              type="button"
              onClick={() => {
                const next = !fileListOpen;
                if (next) setTimeout(() => searchRef.current?.focus(), 0);
                setFileListOpen(next);
              }}
              aria-label={fileListOpen ? 'Collapse file list' : 'Expand file list'}
              title={fileListOpen ? 'Collapse file list' : 'Expand file list'}
            >
              {fileListOpen ? (
                <PanelLeftClose size={13} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={13} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={handleTreeReload}
              aria-label="Reload file tree"
              title="Reload file tree"
              className="file-explorer-reload"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}>
              <X size={14} />
            </button>
          </div>
        </header>
        {fileListOpen && (
          <div className="file-manager-search">
            <Search size={12} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter files"
              className="file-manager-search-input"
            />
            {filter && (
              <button
                type="button"
                className="file-manager-search-clear"
                onClick={() => setFilter('')}
                aria-label="Clear filter"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )}
        <div className={`file-manager-split${fileListOpen ? '' : ' file-list-collapsed'}`}>
          {fileListOpen && (
            <div className="file-explorer-body">
              {loading && <p className="file-explorer-empty">Loading…</p>}
              {!loading && !tree && !error && <p className="file-explorer-empty">Failed to load file tree.</p>}
              {error && !selectedPath && <p className="file-explorer-empty file-explorer-error">{error}</p>}
              {tree?.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  onSelect={handleSelectFile}
                  selectedPath={selectedPath}
                  filter={filter}
                />
              ))}
            </div>
          )}
          <div className="file-manager-content">
            {selectedPath && contentLoading && (
              <div className="file-manager-empty">Loading…</div>
            )}
            {selectedPath && !contentLoading && fileContent === null && !error && (
              <div className="file-manager-empty">Failed to load file.</div>
            )}
            {selectedPath && error && (
              <div className="file-manager-empty file-explorer-error">{error}</div>
            )}
            {selectedPath && !contentLoading && fileContent != null && (
              <>
                <div className="file-manager-content-head">
                  <code title={selectedPath}>{fileName}</code>
                  <span className="file-manager-content-path">{selectedPath}</span>
                  <div className="file-manager-content-actions">
                    {saved && (
                      <span className="file-manager-saved-badge">
                        <Check size={12} aria-hidden="true" />
                        Saved
                      </span>
                    )}
                    {!isEditing ? (
                      <button
                        type="button"
                        className="file-manager-edit-btn"
                        onClick={() => {
                          setIsEditing(true);
                          setEditedContent(fileContent);
                          setTimeout(() => editorRef.current?.focus(), 50);
                        }}
                      >
                        <FileEdit size={12} aria-hidden="true" />
                        Edit
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="file-manager-cancel-btn"
                          onClick={() => {
                            setIsEditing(false);
                            setEditedContent(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="file-manager-save-btn"
                          onClick={handleSave}
                          disabled={saving}
                        >
                          <Save size={12} aria-hidden="true" />
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="file-manager-editor-wrap">
                  {isEditing ? (
                    <div className="file-manager-editor-container">
                      <pre
                        className="file-manager-editor-highlight"
                        aria-hidden="true"
                      >
                        {highlightContent(content)}
                        {'\n'}
                      </pre>
                      <textarea
                        ref={editorRef}
                        className="file-manager-editor"
                        value={content}
                        onChange={(e) => setEditedContent(e.target.value)}
                        onKeyDown={handleEditorKeyDown}
                        onScroll={syncScroll}
                        spellCheck={false}
                        aria-label="File editor"
                      />
                    </div>
                  ) : (
                    <pre className="file-manager-viewer">{fileContent}</pre>
                  )}
                </div>
              </>
            )}
            {!selectedPath && (
              <div className="file-manager-empty">
                <button
                  type="button"
                  className="file-manager-open-list-btn"
                  onClick={() => setFileListOpen(true)}
                >
                  <PanelLeftOpen size={13} aria-hidden="true" />
                  Select a file to view its content
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
