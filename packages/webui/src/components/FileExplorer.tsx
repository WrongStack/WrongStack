import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useFileStore } from '@/stores/file-store';
import type { TreeNode } from '@/stores/file-store';
import { useFileReferenceStore, useSessionStore } from '@/stores';
import { getWSClient } from '@/lib/ws-client';
import { fileIcon, fileIconColor } from '@/lib/file-icons';
import { showPanel } from '@/lib/view-navigation';
import { copyToClipboard as copyTextToClipboard } from './MessageBubble/utils.js';
import { toast } from './Toaster';
import {
  ChevronRight,
  CornerLeftUp,
  FileCode,
  Folder,
  FolderGit,
  FolderOpen,
  Folders,
  Loader2,
  Minimize2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';

// ── Flattened tree rows ────────────────────────────────────────────────
//
// The tree is virtualized (virtua VList): only on-screen rows are mounted,
// so a repo with tens of thousands of files stays cheap. That forces two
// structural rules:
//   1. Expansion state lives in the PARENT as a Set of expanded dir paths —
//      per-row useState would be lost the moment a row scrolls out.
//   2. Rows are memo'd and receive plain props only. The parent owns the
//      single `activeFilePath` store subscription for the whole tree
//      (previously every node subscribed individually, so selecting a file
//      re-rendered every mounted node).

interface FlatRow {
  node: TreeNode;
  depth: number;
  /** Synthetic "(empty)" placeholder under an expanded empty directory. */
  emptyPlaceholder?: boolean;
}

/** Flatten the visible portion of the tree (expanded dirs only). */
function flattenTree(tree: TreeNode[], expandedDirs: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.type === 'directory' && expandedDirs.has(n.path)) {
        const kids = n.children ?? [];
        if (kids.length > 0) walk(kids, depth + 1);
        else out.push({ node: n, depth: depth + 1, emptyPlaceholder: true });
      }
    }
  };
  walk(tree, 0);
  return out;
}

/** Collect every directory path in the tree (for expand-all). */
function collectDirPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === 'directory') {
        out.push(n.path);
        if (n.children) walk(n.children);
      }
    }
  };
  walk(tree);
  return out;
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  emptyPlaceholder,
  expanded,
  isActive,
  isSelected,
  isFocused,
  onToggle,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  emptyPlaceholder?: boolean | undefined;
  expanded: boolean;
  isActive: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onToggle: (path: string) => void;
  onSelect: (filePath: string) => void;
  onOpen: (filePath: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
}) {
  const { t } = useAppTranslation();

  if (emptyPlaceholder) {
    return (
      <div
        className="text-[10px] text-muted-foreground italic py-0.5"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {t('activity:fileExplorer.emptyDir')}
      </div>
    );
  }

  if (node.type === 'directory') {
    const DirIcon = expanded ? FolderOpen : Folder;
    const isGit = node.name === '.git';
    const dirColor = fileIconColor(node.name, true);
    return (
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        aria-level={depth + 1}
        tabIndex={-1}
        onClick={() => onToggle(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={cn(
          'flex items-center gap-1 w-full text-left px-1 py-0.5 text-[11px] rounded',
          'hover:bg-muted/60 transition-colors',
          isFocused && 'ring-1 ring-inset ring-primary/40 bg-muted/40',
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        {isGit ? (
          <FolderGit className={cn('h-3.5 w-3.5 shrink-0', dirColor)} />
        ) : (
          <DirIcon className={cn('h-3.5 w-3.5 shrink-0', dirColor)} />
        )}
        <span className="truncate font-medium flex-1 min-w-0">{node.name}</span>
      </button>
    );
  }

  // Leaf node (file)
  const Icon = fileIcon(node.name);
  const iconColor = fileIconColor(node.name, false);
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isActive || isSelected}
      tabIndex={-1}
      onClick={() => onSelect(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      onDoubleClick={(e) => {
        e.preventDefault();
        onOpen(node.path);
      }}
      className={cn(
        'flex items-center gap-1.5 w-full text-left px-1 py-0.5 text-[11px] rounded',
        'hover:bg-muted/60 transition-colors',
        isActive && 'bg-primary/10 text-primary',
        isSelected && !isActive && 'bg-muted/70 ring-1 ring-inset ring-border',
        isFocused && !isActive && !isSelected && 'ring-1 ring-inset ring-primary/40 bg-muted/40',
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      <span className="w-3 shrink-0" /> {/* spacer to align with chevron */}
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
      <span className="truncate">{node.name}</span>
    </button>
  );
});

// ── File explorer panel ────────────────────────────────────────────────

export function FileExplorer() {
  const { t } = useAppTranslation();
  const tree = useFileStore((s) => s.tree);
  const treeLoading = useFileStore((s) => s.treeLoading);
  const error = useFileStore((s) => s.error);
  const openFiles = useFileStore((s) => s.openFiles);
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  const cwd = useSessionStore((s) => s.cwd);
  const projectName = useSessionStore((s) => s.projectName);

  // Detect OS path separator from cwd (server sends native paths).
  const pathSep = cwd?.includes('\\') ? '\\' : '/';

  /** Middle-truncate a string: keep first N and last M chars, insert … */
  const truncateMiddle = (s: string, keepStart = 8, keepEnd = 4): string => {
    if (s.length <= keepStart + keepEnd + 2) return s;
    return `${s.slice(0, keepStart)}…${s.slice(-keepEnd)}`;
  };

  // Are we in a subdirectory of the project root? Check by comparing
  // the last segment of cwd against the project name.
  const isAtRoot = (() => {
    if (!cwd || !projectName) return true;
    const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    return (segments[segments.length - 1] ?? '') === projectName;
  })();

  // Breadcrumb: split cwd into segments, find the project-root anchor
  // (where the segment matches projectName), then everything after is
  // the relative path. Each segment is clickable to navigate there.
  const breadcrumbs = useMemo(() => {
    if (!cwd || !projectName) return [];
    const norm = cwd.replace(/\\/g, '/');
    const segments = norm.split('/').filter(Boolean);
    // Find the index of the project-root segment (last match of projectName)
    let rootIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i] === projectName) { rootIdx = i; break; }
    }
    if (rootIdx === -1) {
      // Fallback: treat the whole path as relative from the root
      return segments.map((s, i) => ({
        label: s,
        path: '/' + segments.slice(0, i + 1).join('/'),
        isLast: i === segments.length - 1,
      }));
    }
    // Build from rootIdx onward. Segment 0 = project-root label,
    // subsequent segments are the relative path into the project.
    const rel = segments.slice(rootIdx);
    return rel.map((s, i) => ({
      label: i === 0 ? s : s,   // first segment = project name
      path: '/' + segments.slice(0, rootIdx + i + 1).join('/'),
      isLast: i === rel.length - 1,
    }));
  }, [cwd, projectName]);

  // Breadcrumb scroll container — auto-scroll to the rightmost
  // (current) segment so the user always sees where they are.
  const bcRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bcRef.current;
    if (el && breadcrumbs.length > 1) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [breadcrumbs]);

  const handleBreadcrumbClick = useCallback((crumbPath: string) => {
    getWSClient().send({ type: 'working_dir.set', payload: { path: crumbPath } });
  }, []);

  // ── Context menu on breadcrumb right-click ──────────────────────────

  interface CrumbContext {
    absPath: string;
    relPath: string;
  }

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    crumb: CrumbContext;
  } | null>(null);

  // ── Context menu on tree node right-click ────────────────────────────
  //
  // Offers "Mention in chat" (files) and "Copy path" (files + dirs). The
  // file-mention path adds a reference chip to the chat input and switches
  // to the chat view, mirroring the CodeEditor "send to chat" flow.

  const [nodeMenu, setNodeMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      e.preventDefault();
      e.stopPropagation();
      setNodeMenu({ x: e.clientX, y: e.clientY, node });
    },
    [],
  );

  const handleMentionInChat = useCallback((node: TreeNode) => {
    if (node.type === 'file') {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: node.path });
      showPanel('chat');
    }
    setNodeMenu(null);
  }, []);

  // Close context menu on any click outside or Escape
  useEffect(() => {
    if (!contextMenu && !nodeMenu) return;
    const close = () => {
      setContextMenu(null);
      setNodeMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, nodeMenu]);

  const handleBreadcrumbContext = useCallback(
    (e: React.MouseEvent, crumb: CrumbContext) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, crumb });
    },
    [],
  );

  const copyToClipboard = useCallback(
    (text: string) => {
      // Shared helper has an execCommand fallback for blocked clipboard APIs;
      // either way the user gets explicit feedback instead of silence.
      void copyTextToClipboard(text).then((ok) => {
        if (ok) toast.success(t('common:action.copied'));
        else toast.error(t('common:action.copyFailed'));
      });
      setContextMenu(null);
    },
    [t],
  );

  // ── Current file → navigate to its parent directory ─────────────────

  const handleFileIndicatorClick = useCallback(() => {
    if (!activeFilePath) return;
    const norm = activeFilePath.replace(/\\/g, '/');
    const parent = norm.split('/').slice(0, -1).join('/') || '.';
    getWSClient().send({ type: 'working_dir.set', payload: { path: parent } });
  }, [activeFilePath]);

  const handleShellOpen = useCallback((dirPath: string, target: 'terminal' | 'file-manager') => {
    getWSClient().send({ type: 'shell.open', payload: { path: dirPath, target } });
    setContextMenu(null);
  }, []);

  const handleGoUp = useCallback(() => {
    if (!cwd) return;
    // Compute parent: strip the last path segment. On Windows, normalize
    // separators first, then rebuild. Fall back to cwd if already at root.
    const norm = cwd.replace(/\\/g, '/');
    const parent = norm.split('/').slice(0, -1).join('/') || norm;
    getWSClient().send({ type: 'working_dir.set', payload: { path: parent } });
  }, [cwd]);

  // Debounce the loading indicator: only show the spinner after 150ms of
  // continuous loading. Fast refreshes (<150ms) skip the flash entirely.
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (treeLoading) {
      spinnerTimer.current = setTimeout(() => setShowSpinner(true), 150);
    } else {
      if (spinnerTimer.current) clearTimeout(spinnerTimer.current);
      setShowSpinner(false);
    }
    return () => {
      if (spinnerTimer.current) clearTimeout(spinnerTimer.current);
    };
  }, [treeLoading]);

  // Single-click selection highlight (separate from open/sActive state)
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Expanded directories — the single source of truth for the whole tree
  // (rows are virtualized, so per-row state is impossible). Starts empty so
  // the tree is **collapsed by default** on initial load. The user can
  // expand directories manually or use the "Expand All" toolbar button.
  // Once seeded for a cwd, tree REFRESHES (file watcher) keep the user's
  // expansion untouched.
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const seededForCwd = useRef<string | null>(null);
  useEffect(() => {
    if (seededForCwd.current === (cwd ?? '')) return;
    if (tree.length === 0) return; // wait until the tree for this cwd arrives
    seededForCwd.current = cwd ?? '';
  }, [cwd, tree]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** All directory paths, reused by the toolbar badge and expand-all. */
  const allDirPaths = useMemo(() => collectDirPaths(tree), [tree]);
  const dirCount = allDirPaths.length;

  // Visible rows of the flattened tree — this is what the VList renders.
  const rows = useMemo(() => flattenTree(tree, expandedDirs), [tree, expandedDirs]);

  // Count files and folders in the current directory (first-level only)
  const cwdStats = useMemo(() => {
    let files = 0;
    let dirs = 0;
    for (const n of tree) {
      if (n.type === 'directory') dirs++;
      else files++;
    }
    return { files, dirs };
  }, [tree]);

  const handleGlobalCollapse = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);
  const handleGlobalExpand = useCallback(() => {
    setExpandedDirs(new Set(allDirPaths));
  }, [allDirPaths]);

  // Single-click: if already open → switch to that tab. Otherwise → highlight.
  const handleSelect = useCallback(
    (filePath: string) => {
      const existing = openFiles.find((f) => f.path === filePath);
      if (existing) {
        useFileStore.getState().setActiveFile(filePath);
        return;
      }
      // Not open yet — just visually select it
      setSelectedPath((prev) => (prev === filePath ? null : filePath));
    },
    [openFiles],
  );

  // Double-click: always open the file (dispatch to WS server).
  const handleOpen = useCallback((filePath: string) => {
    window.dispatchEvent(
      new CustomEvent('wrongstack:open-file', { detail: { filePath } }),
    );
    setSelectedPath(null);
  }, []);

  // When a file is opened (via double-click or external tab switch),
  // clear the local selection highlight so it doesn't linger.
  useEffect(() => {
    if (activeFilePath) setSelectedPath(null);
  }, [activeFilePath]);

  // ── Keyboard navigation (roving focus over the flattened rows) ───────
  //
  // Rows unmount when virtualized out, so DOM focus can't rove between row
  // buttons; instead the container (role="tree") holds focus and arrow keys
  // move a highlighted index, scrolled into view via the VList handle.
  const listRef = useRef<VListHandle>(null);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const focusedPath =
    focusedIdx >= 0 && focusedIdx < rows.length && !rows[focusedIdx]?.emptyPlaceholder
      ? rows[focusedIdx]?.node.path ?? null
      : null;

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rows.length === 0) return;
      /** Next navigable index in `dir`, skipping "(empty)" placeholders. */
      const nextNav = (from: number, dir: 1 | -1): number => {
        let i = from + dir;
        while (i >= 0 && i < rows.length && rows[i]?.emptyPlaceholder) i += dir;
        return i < 0 || i >= rows.length ? from : i;
      };
      const setFocus = (i: number) => {
        setFocusedIdx(i);
        listRef.current?.scrollToIndex(i, { align: 'nearest' });
      };
      const cur = focusedIdx;
      const row = cur >= 0 && cur < rows.length ? rows[cur] : undefined;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocus(nextNav(cur, 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocus(cur === -1 ? nextNav(rows.length, -1) : nextNav(cur, -1));
          break;
        case 'ArrowRight':
          if (!row || row.emptyPlaceholder) break;
          e.preventDefault();
          if (row.node.type === 'directory') {
            if (!expandedDirs.has(row.node.path)) toggleDir(row.node.path);
            else setFocus(nextNav(cur, 1));
          }
          break;
        case 'ArrowLeft': {
          if (!row || row.emptyPlaceholder) break;
          e.preventDefault();
          if (row.node.type === 'directory' && expandedDirs.has(row.node.path)) {
            toggleDir(row.node.path);
            break;
          }
          // Jump to the parent: the nearest shallower row above.
          for (let i = cur - 1; i >= 0; i--) {
            const cand = rows[i];
            if (cand && !cand.emptyPlaceholder && cand.depth < row.depth) {
              setFocus(i);
              break;
            }
          }
          break;
        }
        case 'Enter':
          if (!row || row.emptyPlaceholder) break;
          e.preventDefault();
          if (row.node.type === 'directory') toggleDir(row.node.path);
          else handleOpen(row.node.path);
          break;
        case ' ':
          if (!row || row.emptyPlaceholder) break;
          e.preventDefault();
          if (row.node.type === 'directory') toggleDir(row.node.path);
          else handleSelect(row.node.path);
          break;
        case 'Home':
          e.preventDefault();
          setFocus(nextNav(-1, 1));
          break;
        case 'End':
          e.preventDefault();
          setFocus(nextNav(rows.length, -1));
          break;
      }
    },
    [rows, focusedIdx, expandedDirs, toggleDir, handleOpen, handleSelect],
  );

  // Entering the tree with Tab highlights the first row so the roving focus
  // is visible immediately (the container suppresses its own outline).
  const handleTreeFocus = useCallback(() => {
    setFocusedIdx((i) => (i === -1 && rows.length > 0 ? 0 : i));
  }, [rows.length]);

  if (showSpinner) {
    return (
      <div className="flex items-center justify-center h-full py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 text-[11px] text-destructive">
        {t('activity:fileExplorer.loadFailed', { error })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* ── Toolbar ── */}
      {tree.length > 0 && dirCount > 0 && (
        <div className="flex items-center gap-0.5 px-2 py-0.5 border-b shrink-0">
          <button
            type="button"
            onClick={handleGlobalExpand}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
              'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
            title={t('activity:fileExplorer.expandAllTitle')}
          >
            <Folders className="h-3 w-3" />
            <span>{t('activity:fileExplorer.expandAll')}</span>
          </button>
          <button
            type="button"
            onClick={handleGlobalCollapse}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
              'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
            title={t('activity:fileExplorer.collapseAllTitle')}
          >
            <Minimize2 className="h-3 w-3" />
            <span>{t('activity:fileExplorer.collapse')}</span>
          </button>
          <span className="ml-auto text-[9px] text-muted-foreground/70 tabular-nums">
            {t('activity:fileExplorer.folders', { count: dirCount })}
          </span>
        </div>
      )}
      {/* ── Fixed headers (breadcrumb / current file / parent-dir) — kept
          outside the virtualized list so they're always visible and the
          VList owns the scroll area exclusively. ── */}
      <div className="min-h-0 min-w-0 flex flex-1 flex-col py-1">
        {/* ── Breadcrumb bar — clickable path segments ── */}
        {breadcrumbs.length > 0 && (
          <div
            ref={bcRef}
            className="relative flex shrink-0 items-center gap-0.5 px-1 pb-1 border-b border-border/30 overflow-x-auto"
          >
            {/* Left-edge fade mask — visible when content overflows to the left */}
            <span className="sticky left-0 shrink-0 w-3 h-full bg-gradient-to-r from-background to-transparent pointer-events-none" />
            {breadcrumbs.map((crumb, i) => {
              const displayLabel = crumb.isLast
                ? crumb.label
                : truncateMiddle(crumb.label);
              const tooltipPath = crumb.path.replace(/\//g, pathSep);

              // Build absolute and relative paths for context menu
              const normSegments = cwd
                ? cwd.replace(/\\/g, '/').split('/').filter(Boolean)
                : [];
              const rootIdx = (() => {
                for (let j = normSegments.length - 1; j >= 0; j--) {
                  if (normSegments[j] === projectName) return j;
                }
                return -1;
              })();
              const absSegments = rootIdx >= 0
                ? normSegments.slice(0, rootIdx + i + 1)
                : normSegments.slice(0, i + 1);
              const absPath = pathSep === '\\'
                ? absSegments.join('\\')
                : '/' + absSegments.join('/');
              const relSegments = rootIdx >= 0
                ? normSegments.slice(rootIdx + 1, rootIdx + i + 1)
                : [];
              const relPath = relSegments.join(pathSep) || '.';

              return (
              <span key={crumb.path} className="flex items-center gap-0.5 shrink-0">
                {i > 0 && (
                  <span className="text-[9px] text-muted-foreground/65 select-none">{pathSep}</span>
                )}
                <button
                  type="button"
                  onClick={() => handleBreadcrumbClick(crumb.path)}
                  onContextMenu={(e) => handleBreadcrumbContext(e, { absPath, relPath })}
                  className={cn(
                    'px-1 py-0.5 rounded text-[11px] transition-colors whitespace-nowrap',
                    crumb.isLast
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                  )}
                  title={crumb.isLast ? t('activity:fileExplorer.currentDirTitle', { path: tooltipPath }) : t('activity:fileExplorer.navigateToTitle', { path: tooltipPath })}
                >
                  {displayLabel}
                </button>
              </span>
              );
            })}
            {/* ── File/folder counter badge ── */}
            {tree.length > 0 && (
              <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/70 tabular-nums pl-2">
                {cwdStats.files > 0 && t('activity:fileExplorer.filesSuffix', { count: cwdStats.files })}
                {cwdStats.files > 0 && cwdStats.dirs > 0 && ', '}
                {cwdStats.dirs > 0 && t('activity:fileExplorer.folders', { count: cwdStats.dirs })}
              </span>
            )}
          </div>
        )}
        {/* ── Current file indicator — shows which file is open/selected ── */}
        {activeFilePath && (
          <button
            type="button"
            onClick={handleFileIndicatorClick}
            className="flex shrink-0 items-center gap-1 w-full text-left px-2 py-0.5 border-b border-border/30 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            title={t('activity:fileExplorer.navigateParentTitle', { path: activeFilePath.replace(/\//g, pathSep) })}
          >
            <FileCode className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {(() => {
                const segments = activeFilePath.replace(/\\/g, '/').split('/');
                return segments[segments.length - 1] ?? activeFilePath;
              })()}
            </span>
            <span className="ml-auto text-[8px] text-muted-foreground/65 shrink-0">
              {t('activity:fileExplorer.goToDir')}
            </span>
          </button>
        )}
        {/* ── Parent directory fallback (when breadcrumbs can't be computed) ── */}
        {breadcrumbs.length === 0 && !isAtRoot && (
          <button
            type="button"
            onClick={handleGoUp}
            className={cn(
              'flex shrink-0 items-center gap-1.5 w-full text-left px-1 py-0.5 text-[11px] rounded',
              'hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground',
              'font-medium',
            )}
          >
            <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
            <span>..</span>
            <span className="text-[9px] text-muted-foreground/70 ml-auto">
              {t('activity:fileExplorer.parentDirectory')}
            </span>
          </button>
        )}
        {tree.length > 0 ? (
          <div
            role="tree"
            aria-label={t('activity:fileExplorer.folders', { count: dirCount })}
            tabIndex={0}
            onKeyDown={handleTreeKeyDown}
            onFocus={handleTreeFocus}
            className="min-h-0 min-w-0 flex-1 outline-none"
          >
            <VList ref={listRef} className="h-full">
              {rows.map((row) => (
                <TreeRow
                  key={row.emptyPlaceholder ? `${row.node.path}#empty` : row.node.path}
                  node={row.node}
                  depth={row.depth}
                  emptyPlaceholder={row.emptyPlaceholder}
                  expanded={row.node.type === 'directory' && expandedDirs.has(row.node.path)}
                  isActive={row.node.type === 'file' && row.node.path === activeFilePath}
                  isSelected={!row.emptyPlaceholder && row.node.path === selectedPath}
                  isFocused={!row.emptyPlaceholder && row.node.path === focusedPath}
                  onToggle={toggleDir}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                  onContextMenu={handleNodeContextMenu}
                />
              ))}
            </VList>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground italic p-2">
            {t('activity:fileExplorer.noFiles')}
          </p>
        )}
      </div>

      {/* ── Breadcrumb right-click context menu ── */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[140px] bg-popover border rounded-md shadow-md py-1 text-[11px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={() => copyToClipboard(contextMenu.crumb.absPath)}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            {t('activity:fileExplorer.copyAbsPath')}
          </button>
          <button
            type="button"
            onClick={() => copyToClipboard(contextMenu.crumb.relPath)}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            {t('activity:fileExplorer.copyRelPath')}
          </button>
          <div className="border-t border-border/50 my-0.5" />
          <button
            type="button"
            onClick={() => handleShellOpen(contextMenu.crumb.absPath, 'terminal')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            {t('activity:fileExplorer.openInTerminal')}
          </button>
          <button
            type="button"
            onClick={() => handleShellOpen(contextMenu.crumb.absPath, 'file-manager')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            {t('activity:fileExplorer.openInFileManager')}
          </button>
          <div className="border-t border-border/50 mt-0.5 pt-0.5">
            <div className="px-3 py-1 text-[9px] text-muted-foreground/70 truncate max-w-[200px]">
              {contextMenu.crumb.absPath}
            </div>
          </div>
        </div>
      )}

      {/* ── Tree node right-click context menu ── */}
      {nodeMenu && (
        <div
          className="fixed z-50 min-w-[160px] bg-popover border rounded-md shadow-md py-1 text-[11px]"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
        >
          {nodeMenu.node.type === 'file' && (
            <button
              type="button"
              onClick={() => handleMentionInChat(nodeMenu.node)}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
            >
              {t('activity:fileExplorer.mentionInChat')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void copyTextToClipboard(nodeMenu.node.path).then((ok) => {
                if (ok) toast.success(t('common:action.copied'));
                else toast.error(t('common:action.copyFailed'));
              });
              setNodeMenu(null);
            }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            {t('activity:fileExplorer.copyPath')}
          </button>
          <div className="border-t border-border/50 mt-0.5 pt-0.5">
            <div className="px-3 py-1 text-[9px] text-muted-foreground/70 truncate max-w-[200px]">
              {nodeMenu.node.path}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
