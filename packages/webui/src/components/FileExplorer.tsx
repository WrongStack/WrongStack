import {
  ArrowDownWideNarrow,
  CornerLeftUp,
  FileCode,
  Folders,
  Loader2,
  Minimize2,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import {
  useActiveSessionId,
  useFileReferenceStore,
  useGitChangesStore,
  useSessionStore,
} from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';
import type { TreeNode } from '@/stores/file-store';
import { useFileStore } from '@/stores/file-store';
import {
  BreadcrumbContextMenu,
  CreatePromptModal,
  NodeContextMenu,
  RenamePromptModal,
} from './FileExplorer/FileExplorerModals.js';
import { TreeRow } from './FileExplorer/TreeRow.js';
import {
  collectAllFiles,
  collectDirPaths,
  flattenTree,
  scoreFile,
  treeRowId,
} from './FileExplorer/tree-helpers.js';
import type {
  CreatePromptState,
  CrumbContext,
  FlatRow,
  RenamePromptState,
} from './FileExplorer/types.js';
import { copyToClipboard as copyTextToClipboard } from './MessageBubble/utils.js';
import { toast } from './Toaster';

type FileExplorerChrome = {
  contextMenu: { x: number; y: number; crumb: CrumbContext } | null;
  nodeMenu: { x: number; y: number; node: TreeNode } | null;
  createPrompt: CreatePromptState | null;
  createName: string;
  renamePrompt: RenamePromptState | null;
  renameValue: string;
  selectedPath: string | null;
  expandedDirs: string[];
  sortBySize: boolean;
  searchQuery: string;
  focusedIdx: number;
};

const FILE_EXPLORER_NO_SESSION = '__no_session__';
const fileExplorerChromeBySession = new Map<string, FileExplorerChrome>();
const disposedFileExplorerSessions = new Set<string>();

onLaneDisposed((sessionId) => {
  fileExplorerChromeBySession.delete(sessionId);
  disposedFileExplorerSessions.add(sessionId);
});

export function FileExplorer() {
  const { t } = useAppTranslation();
  const sessionId = useActiveSessionId();
  const tree = useFileStore((s) => s.tree);
  const treeLoading = useFileStore((s) => s.treeLoading);
  const error = useFileStore((s) => s.error);
  const openFiles = useFileStore((s) => s.openFiles);
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  const cwd = useSessionStore((s) => s.cwd);
  const projectName = useSessionStore((s) => s.projectName);
  const gitChanges = useGitChangesStore((s) => s.files);
  const gitRepoPrefix = useGitChangesStore((s) => s.repoPrefix);
  const gitDirs = useGitChangesStore((s) => s.dirs);

  const gitStatusMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of gitChanges) {
      const norm = f.path.replace(/\\/g, '/').replace(/^\//, '');
      m.set(norm, f.status);
    }
    return m;
  }, [gitChanges]);

  const dirStatusMap = useMemo(() => new Map(Object.entries(gitDirs)), [gitDirs]);

  const getGitStatus = useCallback(
    (nodePath: string, isDir: boolean): string | undefined => {
      const root = (cwd || projectName || '')
        .replace(/\\/g, '/')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      let norm = nodePath.replace(/\\/g, '/').replace(/^\//, '');
      if (root && norm.startsWith(root + '/')) {
        norm = norm.slice(root.length + 1);
      }
      // Tree paths are PROJECT-root-relative; porcelain paths from
      // git.changes are REPO-root-relative. When a repo subdirectory is
      // opened as the project, git keys carry a prefix the tree never
      // emits — prepend the server-computed repoPrefix (see
      // repoRelativePrefix in webui-server git-handlers) to align them.
      const key = gitRepoPrefix + norm;
      const direct = gitStatusMap.get(key);
      if (direct) return direct;
      if (isDir) {
        // Directory badges come from the server-computed aggregate in
        // git.changes (highest-ranked child status) — no client-side
        // prefix scanning over the file map.
        return dirStatusMap.get(key);
      }
      return undefined;
    },
    [gitStatusMap, dirStatusMap, gitRepoPrefix, cwd, projectName],
  );

  const pathSep = cwd?.includes('\\') ? '\\' : '/';

  const truncateMiddle = (s: string, keepStart = 8, keepEnd = 4): string => {
    if (s.length <= keepStart + keepEnd + 2) return s;
    return `${s.slice(0, keepStart)}…${s.slice(-keepEnd)}`;
  };

  const isAtRoot = (() => {
    if (!cwd || !projectName) return true;
    const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    return (segments[segments.length - 1] ?? '') === projectName;
  })();

  const breadcrumbs = useMemo(() => {
    if (!cwd || !projectName) return [];
    const norm = cwd.replace(/\\/g, '/');
    const segments = norm.split('/').filter(Boolean);
    let rootIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i] === projectName) {
        rootIdx = i;
        break;
      }
    }
    if (rootIdx === -1) {
      return segments.map((s, i) => ({
        label: s,
        path: '/' + segments.slice(0, i + 1).join('/'),
        isLast: i === segments.length - 1,
      }));
    }
    const rel = segments.slice(rootIdx);
    return rel.map((s, i) => ({
      label: s,
      path: '/' + segments.slice(0, rootIdx + i + 1).join('/'),
      isLast: i === rel.length - 1,
    }));
  }, [cwd, projectName]);

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

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    crumb: CrumbContext;
  } | null>(null);

  const [nodeMenu, setNodeMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setNodeMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleMentionInChat = useCallback((node: TreeNode) => {
    if (node.type === 'file') {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: node.path });
      showPanel('chat');
    }
    setNodeMenu(null);
  }, []);

  const handleBreadcrumbContext = useCallback((e: React.MouseEvent, crumb: CrumbContext) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, crumb });
  }, []);

  const copyToClipboard = useCallback(
    (text: string) => {
      void copyTextToClipboard(text).then((ok) => {
        if (ok) toast.success(t('common:action.copied'));
        else toast.error(t('common:action.copyFailed'));
      });
      setContextMenu(null);
    },
    [t],
  );

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

  const [createPrompt, setCreatePrompt] = useState<CreatePromptState | null>(null);
  const [createName, setCreateName] = useState('');

  const handleStartCreate = useCallback((dirPath: string, type: 'file' | 'directory') => {
    setNodeMenu(null);
    setCreateName('');
    setCreatePrompt({ dirPath, type });
  }, []);

  const handleConfirmCreate = useCallback(() => {
    if (!createPrompt || !createName.trim()) return;
    const filePath = createPrompt.dirPath
      ? `${createPrompt.dirPath}/${createName.trim()}`
      : createName.trim();
    getWSClient().send({
      type: 'files.create',
      payload: getWSClient().withSession({ filePath, type: createPrompt.type }),
    });
    setCreatePrompt(null);
    setCreateName('');
  }, [createPrompt, createName]);

  const handleDelete = useCallback(
    (node: TreeNode) => {
      setNodeMenu(null);
      const isDir = node.type === 'directory';
      // Both kinds are destructive on disk — confirm files exactly like
      // directories (and like ChangesPanel's discard).
      const ok = window.confirm(
        isDir
          ? t('activity:fileExplorer.confirmDeleteDir', { name: node.name })
          : t('activity:fileExplorer.confirmDeleteFile', { name: node.name }),
      );
      if (!ok) return;
      getWSClient().send({
        type: 'files.delete',
        payload: getWSClient().withSession({ filePath: node.path, recursive: isDir }),
      });
    },
    [t],
  );

  const [renamePrompt, setRenamePrompt] = useState<RenamePromptState | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleStartRename = useCallback((node: TreeNode) => {
    setNodeMenu(null);
    setRenameValue(node.name);
    setRenamePrompt({ oldPath: node.path, initialName: node.name });
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (!renamePrompt || !renameValue.trim()) return;
    const norm = renamePrompt.oldPath.replace(/\\/g, '/');
    const parent = norm.split('/').slice(0, -1).join('/');
    const newPath = parent ? `${parent}/${renameValue.trim()}` : renameValue.trim();
    if (newPath === renamePrompt.oldPath) {
      setRenamePrompt(null);
      return;
    }
    getWSClient().send({
      type: 'files.rename',
      payload: getWSClient().withSession({ oldPath: renamePrompt.oldPath, newPath }),
    });
    setRenamePrompt(null);
    setRenameValue('');
  }, [renamePrompt, renameValue]);

  const handleGoUp = useCallback(() => {
    if (!cwd) return;
    const norm = cwd.replace(/\\/g, '/');
    const parent = norm.split('/').slice(0, -1).join('/') || norm;
    getWSClient().send({ type: 'working_dir.set', payload: { path: parent } });
  }, [cwd]);

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

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const seededForCwd = useRef<string | null>(null);
  useEffect(() => {
    if (seededForCwd.current === (cwd ?? '')) return;
    if (tree.length === 0) return;
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

  const allDirPaths = useMemo(() => collectDirPaths(tree), [tree]);
  const dirCount = allDirPaths.length;

  const [sortBySize, setSortBySize] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const chromeSessionRef = useRef<string>(sessionId ?? FILE_EXPLORER_NO_SESSION);

  useLayoutEffect(() => {
    if (!disposedFileExplorerSessions.has(chromeSessionRef.current)) {
      fileExplorerChromeBySession.set(chromeSessionRef.current, {
        contextMenu,
        nodeMenu,
        createPrompt,
        createName,
        renamePrompt,
        renameValue,
        selectedPath,
        expandedDirs: [...expandedDirs],
        sortBySize,
        searchQuery,
        focusedIdx,
      });
    }

    const next = sessionId ?? FILE_EXPLORER_NO_SESSION;
    const parked = fileExplorerChromeBySession.get(next);
    disposedFileExplorerSessions.delete(next);
    setContextMenu(parked?.contextMenu ?? null);
    setNodeMenu(parked?.nodeMenu ?? null);
    setCreatePrompt(parked?.createPrompt ?? null);
    setCreateName(parked?.createName ?? '');
    setRenamePrompt(parked?.renamePrompt ?? null);
    setRenameValue(parked?.renameValue ?? '');
    setSelectedPath(parked?.selectedPath ?? null);
    setExpandedDirs(new Set(parked?.expandedDirs ?? []));
    setSortBySize(parked?.sortBySize ?? false);
    setSearchQuery(parked?.searchQuery ?? '');
    setFocusedIdx(parked?.focusedIdx ?? -1);
    chromeSessionRef.current = next;
  }, [sessionId]);

  const sortedTree = useMemo(() => {
    if (!sortBySize) return tree;
    const sorted = [...tree].sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'directory') return 1;
      if (a.type === 'directory') return a.name.localeCompare(b.name);
      const sizeA = a.size ?? 0;
      const sizeB = b.size ?? 0;
      if (sizeB !== sizeA) return sizeB - sizeA;
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [tree, sortBySize]);

  const rows = useMemo(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const allFiles = collectAllFiles(sortedTree);
      return allFiles
        .map((n) => ({ node: n, score: scoreFile(n.path, q) }))
        .filter((r) => r.score >= 0)
        .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path))
        .slice(0, 200)
        .map((r) => ({ node: r.node, depth: 0 }) as FlatRow);
    }
    return flattenTree(sortedTree, expandedDirs);
  }, [sortedTree, expandedDirs, searchQuery]);

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

  const handleSelect = useCallback(
    (filePath: string) => {
      const existing = openFiles.find((f) => f.path === filePath);
      if (existing) {
        useFileStore.getState().setActiveFile(filePath);
        return;
      }
      setSelectedPath((prev) => (prev === filePath ? null : filePath));
    },
    [openFiles],
  );

  const handleOpen = useCallback((filePath: string) => {
    window.dispatchEvent(new CustomEvent('wrongstack:open-file', { detail: { filePath } }));
    setSelectedPath(null);
  }, []);

  useEffect(() => {
    if (activeFilePath) setSelectedPath(null);
  }, [activeFilePath]);

  const listRef = useRef<VListHandle>(null);
  const focusedPath =
    focusedIdx >= 0 && focusedIdx < rows.length && !rows[focusedIdx]?.emptyPlaceholder
      ? (rows[focusedIdx]?.node.path ?? null)
      : null;

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rows.length === 0) return;
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
        case 'F10':
        case 'ContextMenu': {
          // Shift+F10 / Menu key — open the row context menu anchored at the
          // focused row, giving keyboard users the same actions as right-click.
          if (e.key === 'F10' && !e.shiftKey) break;
          if (!row || row.emptyPlaceholder) break;
          e.preventDefault();
          const rect = document.getElementById(treeRowId(row.node.path))?.getBoundingClientRect();
          setNodeMenu({
            x: rect?.left ?? window.innerWidth / 2,
            y: rect ? rect.bottom + 2 : window.innerHeight / 2,
            node: row.node,
          });
          break;
        }
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {error && (
        <div className="flex shrink-0 items-center gap-1.5 px-2 py-1 border-b border-destructive/30 bg-destructive/5 text-[10px] text-destructive">
          <span className="truncate flex-1 min-w-0">
            {t('activity:fileExplorer.loadFailed', { error })}
          </span>
          <button
            type="button"
            onClick={() => useFileStore.getState().setError(null)}
            className="shrink-0 text-destructive/70 hover:text-destructive text-[10px]"
            title={t('common:action.dismiss')}
            aria-label={t('common:action.dismiss')}
          >
            ✕
          </button>
        </div>
      )}
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
          <button
            type="button"
            onClick={() => setSortBySize((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
              'hover:bg-muted/60',
              sortBySize ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            title={
              sortBySize
                ? t('activity:fileExplorer.sortByNameTitle')
                : t('activity:fileExplorer.sortBySizeTitle')
            }
          >
            <ArrowDownWideNarrow className="h-3 w-3" />
            <span>
              {sortBySize
                ? t('activity:fileExplorer.sortBySize')
                : t('activity:fileExplorer.sortByName')}
            </span>
          </button>
          <div className="relative flex items-center">
            <Search className="absolute left-1 h-3 w-3 text-muted-foreground/60 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('activity:fileExplorer.searchPlaceholder')}
              className="w-28 rounded bg-muted/40 px-1 py-0.5 pl-4 text-[10px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:w-40 focus:bg-muted/70 focus:ring-1 focus:ring-primary/30 transition-all"
              aria-label={t('activity:fileExplorer.search')}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-0.5 text-muted-foreground/60 hover:text-foreground text-[10px]"
                aria-label={t('common:action.clear')}
              >
                ✕
              </button>
            )}
          </div>
          <span className="ml-auto text-[9px] text-muted-foreground/70 tabular-nums">
            {t('activity:fileExplorer.folders', { count: dirCount })}
          </span>
        </div>
      )}
      <div className="min-h-0 min-w-0 flex flex-1 flex-col py-1">
        {breadcrumbs.length > 0 && (
          <div
            ref={bcRef}
            className="relative flex shrink-0 items-center gap-0.5 px-1 pb-1 border-b border-border/30 overflow-x-auto"
          >
            <span className="sticky left-0 shrink-0 w-3 h-full bg-gradient-to-r from-background to-transparent pointer-events-none" />
            {breadcrumbs.map((crumb, i) => {
              const displayLabel = crumb.isLast ? crumb.label : truncateMiddle(crumb.label);
              const tooltipPath = crumb.path.replace(/\//g, pathSep);

              const normSegments = cwd ? cwd.replace(/\\/g, '/').split('/').filter(Boolean) : [];
              const rootIdx = (() => {
                for (let j = normSegments.length - 1; j >= 0; j--) {
                  if (normSegments[j] === projectName) return j;
                }
                return -1;
              })();
              const absSegments =
                rootIdx >= 0
                  ? normSegments.slice(0, rootIdx + i + 1)
                  : normSegments.slice(0, i + 1);
              const absPath =
                pathSep === '\\' ? absSegments.join('\\') : '/' + absSegments.join('/');
              const relSegments =
                rootIdx >= 0 ? normSegments.slice(rootIdx + 1, rootIdx + i + 1) : [];
              const relPath = relSegments.join(pathSep) || '.';

              return (
                <span key={crumb.path} className="flex items-center gap-0.5 shrink-0">
                  {i > 0 && (
                    <span className="text-[9px] text-muted-foreground/65 select-none">
                      {pathSep}
                    </span>
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
                    title={
                      crumb.isLast
                        ? t('activity:fileExplorer.currentDirTitle', { path: tooltipPath })
                        : t('activity:fileExplorer.navigateToTitle', { path: tooltipPath })
                    }
                  >
                    {displayLabel}
                  </button>
                </span>
              );
            })}
            {tree.length > 0 && (
              <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/70 tabular-nums pl-2">
                {cwdStats.files > 0 &&
                  t('activity:fileExplorer.filesSuffix', { count: cwdStats.files })}
                {cwdStats.files > 0 && cwdStats.dirs > 0 && ', '}
                {cwdStats.dirs > 0 && t('activity:fileExplorer.folders', { count: cwdStats.dirs })}
              </span>
            )}
          </div>
        )}
        {activeFilePath && (
          <button
            type="button"
            onClick={handleFileIndicatorClick}
            className="flex shrink-0 items-center gap-1 w-full text-left px-2 py-0.5 border-b border-border/30 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            title={t('activity:fileExplorer.navigateParentTitle', {
              path: activeFilePath.replace(/\//g, pathSep),
            })}
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
            id="ws-file-tree"
            role="tree"
            aria-label={t('activity:fileExplorer.folders', { count: dirCount })}
            aria-activedescendant={focusedPath ? treeRowId(focusedPath) : undefined}
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
                  gitStatus={
                    !row.emptyPlaceholder
                      ? getGitStatus(row.node.path, row.node.type === 'directory')
                      : undefined
                  }
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

      {contextMenu && (
        <BreadcrumbContextMenu
          contextMenu={contextMenu}
          onClose={() => setContextMenu(null)}
          copyToClipboard={copyToClipboard}
          handleStartCreate={handleStartCreate}
          handleShellOpen={handleShellOpen}
        />
      )}

      {nodeMenu && (
        <NodeContextMenu
          nodeMenu={nodeMenu}
          onClose={() => setNodeMenu(null)}
          handleMentionInChat={handleMentionInChat}
          copyNodePath={(path) => {
            void copyTextToClipboard(path).then((ok) => {
              if (ok) toast.success(t('common:action.copied'));
              else toast.error(t('common:action.copyFailed'));
            });
            setNodeMenu(null);
          }}
          handleStartCreate={handleStartCreate}
          handleStartRename={handleStartRename}
          handleDelete={handleDelete}
        />
      )}

      {createPrompt && (
        <CreatePromptModal
          createPrompt={createPrompt}
          createName={createName}
          setCreateName={setCreateName}
          onCancel={() => {
            setCreatePrompt(null);
            setCreateName('');
          }}
          onConfirm={handleConfirmCreate}
        />
      )}

      {renamePrompt && (
        <RenamePromptModal
          renamePrompt={renamePrompt}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          onCancel={() => {
            setRenamePrompt(null);
            setRenameValue('');
          }}
          onConfirm={handleConfirmRename}
        />
      )}
    </div>
  );
}
