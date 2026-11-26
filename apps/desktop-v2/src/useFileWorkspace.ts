import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { plainEditorPreferred } from './CodeEditorSlot';
import type { ComposerFileReference } from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries } from './engine-values';
import { useTreeChanges } from './FileTreeView';
import { type FileDraftSnapshot, FileDraftStore } from './file-draft';
import {
  type FileNode,
  fileName,
  fileTree,
  flattenFiles,
  parentPath,
  projectRelativePath,
  reviewText,
} from './file-model';
import { fileRefreshQueue } from './file-refresh';
import { saveFileVersion } from './file-save';
import { selectionReference } from './file-selection-reference';
import * as treeCache from './file-tree-cache';
import { createFileWorkspaceOperations } from './file-workspace-operations';
import type { Action, Document } from './file-workspace-types';
import { fileDraftStorage, request } from './platform';
import type { ReviewNote } from './review-notes-store';
import { useReviewNotes } from './useReviewNotes';
import type { ViewerFind } from './ViewerFindBar';

interface Chrome {
  documents: Record<string, Document>;
  active: string;
  folder: string;
  expanded: string[];
  notes: ReviewNote[];
  includeIgnored: boolean;
  treeCollapsed: boolean;
}
const chrome = new Map<string, Chrome>();
// A window retains the same draft revisions when its project tools remount.
// Other native windows have independent stores and must still pass the SQLite revision check.
const fileDraftStores = new Map<string, FileDraftStore>();
const FOLDER_PAGE = 200;

export function useFileWorkspace({
  command,
  scopeKey,
  projectId,
  mode = 'files',
  initialPath = '',
  initialPathIsFile = false,
  initialLine,
  initialEndLine,
  onReview,
  onReference,
  send,
  state,
}: {
  command: EngineCommand;
  scopeKey: string;
  projectId: string;
  mode?: 'files' | 'changes';
  initialPath?: string;
  /** A caller-validated file can be read without waiting for the explorer listing. */
  initialPathIsFile?: boolean;
  /** 1-based source line to reveal and mark when `initialPath` opens a file. */
  initialLine?: number;
  /** Last line of the range to mark, when the target is a range. */
  initialEndLine?: number;
  onReview?: (text: string) => void;
  /** Attach the open file, or its selected lines, to the owning conversation. */
  onReference?: (ref: ComposerFileReference) => void;
  send: EngineSend;
  state: EngineState;
}) {
  const key = scopeKey
    .replaceAll('\\', '/')
    .replace(/^\/\/\?\//, '')
    .toLowerCase();
  const cached = chrome.get(key);
  const { t } = useDesktopText();
  const [tree, setTree] = useState<FileNode[]>([]),
    [git, setGit] = useState<Record<string, unknown>>({}),
    [documents, setDocuments] = useState<Record<string, Document>>(cached?.documents ?? {}),
    [active, setActive] = useState(cached?.active ?? ''),
    [folder, setFolder] = useState(cached?.folder ?? ''),
    [expanded, setExpanded] = useState<string[]>(cached?.expanded ?? []),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(''),
    [treeLoading, setTreeLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [plainEditor, setPlainEditor] = useState(plainEditorPreferred),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [diff, setDiff] = useState<Record<string, unknown> | null>(null),
    [action, setAction] = useState<Action | null>(null),
    [value, setValue] = useState(''),
    [hunkReview, setHunkReview] = useState(false),
    [mergeReview, setMergeReview] = useState(false),
    [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null),
    [sort, setSort] = useState('name'),
    [history, setHistory] = useState(false),
    [treeReady, setTreeReady] = useState(false),
    [includeIgnored, setIncludeIgnored] = useState(cached?.includeIgnored ?? false),
    [treeCollapsed, setTreeCollapsed] = useState(cached?.treeCollapsed ?? false),
    [treeFilter, setTreeFilter] = useState<boolean | null>(null);
  // Collapse controls point at the tree panel via aria-controls; useId keeps the id unique
  // when several file workspaces are mounted at once.
  const treePanelId = useId();
  const revealed = useRef('');
  const reviewNotes = useReviewNotes(projectId, cached?.notes ?? []);
  const notes = reviewNotes.notes;
  const contentElement = useRef<HTMLDivElement>(null);
  const fileReads = useRef(new Set<string>());
  const searchRevealed = useRef('');
  const [contentSearch, setContentSearch] = useState(false);
  const [searchSelection, setSearchSelection] = useState<{
    path: string;
    line: number;
    /** Last line of a marked range; absent for a single line. */
    endLine?: number;
    id: string;
  } | null>(null);
  const draftStore = useMemo(() => {
    const owner = `${projectId}:${key}`;
    let store = fileDraftStores.get(owner);
    if (!store) {
      store = new FileDraftStore(fileDraftStorage(projectId));
      fileDraftStores.set(owner, store);
    }
    return store;
  }, [projectId, key]);
  const [recoverable, setRecoverable] = useState<string[]>([]);
  const [draftConflict, setDraftConflict] = useState<{
    path: string;
    snapshot: FileDraftSnapshot;
  } | null>(null);
  const refreshDrafts = useCallback(async () => {
    const result = await request<{ drafts: { path: string }[] }>('file-drafts.list', { projectId });
    setRecoverable(
      result.drafts.map((draft) => draft.path).filter((path) => typeof path === 'string'),
    );
  }, [projectId]);
  useEffect(() => {
    void refreshDrafts().catch((error: unknown) => setError(String(error)));
  }, [refreshDrafts]);
  const docs = useRef(documents);
  const activeFile = useRef(active);
  docs.current = documents;
  useLayoutEffect(() => {
    activeFile.current = active;
  }, [active]);
  useEffect(() => {
    chrome.set(key, { documents, active, folder, expanded, notes, includeIgnored, treeCollapsed });
  }, [key, documents, active, folder, expanded, notes, includeIgnored, treeCollapsed]);
  const all = useMemo(() => flattenFiles(tree), [tree]);
  const prefix = typeof git['repoPrefix'] === 'string' ? git['repoPrefix'] : '';
  const changes = entries(git['files']).filter((file) => String(file['path']).startsWith(prefix));
  const asGitPath = useCallback((path: string) => `${prefix}${path}`, [prefix]);
  const fromGitPath = (path: string) =>
    prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  // Current change marker and filter key, so superseded reads never overwrite newer state.
  const listingKey = treeCache.treeListingKey(projectId, scopeKey, includeIgnored);
  const live = useRef({ changed: state.results['files.tree.changed'], key: listingKey });
  live.current = { changed: state.results['files.tree.changed'], key: listingKey };
  const applyGit = useCallback((r: PromiseSettledResult<Record<string, unknown>>) => {
    setGit(r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message ?? r.reason) });
  }, []);
  const refresh = useMemo(
    () =>
      fileRefreshQueue(async () => {
        const marker = live.current.changed;
        const results = await Promise.allSettled([
          command('files.tree', { includeIgnored }, ['files.tree']),
          command('git.changes', {}, ['git.changes']),
        ]);
        if (results[0].status !== 'fulfilled') throw results[0].reason;
        treeCache.rememberTreeListing(listingKey, results[0].value['tree'], marker);
        if (live.current.key !== listingKey) return;
        setTree(fileTree(results[0].value['tree']));
        setTreeReady(true);
        setTreeFilter(includeIgnored);
        applyGit(results[1]);
      }),
    [command, includeIgnored, listingKey, applyGit],
  );
  const reload = () => {
    treeCache.clearProjectTreeListings(projectId);
    return refresh();
  };
  useEffect(() => () => refresh.clear(), [refresh]);
  useEffect(() => {
    const listing = treeCache.currentTreeListing(listingKey, live.current.changed);
    if (listing !== undefined) {
      setTree(fileTree(listing));
      setTreeReady(true);
      setTreeFilter(includeIgnored);
      setTreeLoading(false);
      void Promise.allSettled([command('git.changes', {}, ['git.changes'])]).then(
        ([r]) => live.current.key === listingKey && applyGit(r),
      );
      return;
    }
    setTreeLoading(true);
    const onFail = (e: unknown) =>
      live.current.key === listingKey && setError(e instanceof Error ? e.message : String(e));
    void refresh()
      .catch(onFail)
      .finally(() => live.current.key === listingKey && setTreeLoading(false));
  }, [refresh]);
  useTreeChanges(state.results['files.tree.changed'], refresh, setError);
  const openFile = useCallback(
    async (rawPath: string) => {
      const path = projectRelativePath(rawPath, scopeKey);
      activeFile.current = path;
      setActive(path);
      setError('');
      setNotice('');
      setExpanded((paths) => [
        ...new Set([
          ...paths,
          ...path
            .split('/')
            .slice(0, -1)
            .map((_, index) =>
              path
                .split('/')
                .slice(0, index + 1)
                .join('/'),
            ),
        ]),
      ]);
      if (docs.current[path]) return;
      setLoading(path);
      if (fileReads.current.has(path)) return;
      fileReads.current.add(path);
      try {
        const draft = (await draftStore.load(path)).value;
        const result = await command('files.read', { filePath: path }, ['files.read']).catch(
          (error: unknown) => {
            if (!draft) throw error;
            if (activeFile.current === path) setNotice(t('fileView.sourceGone'));
            return {} as Record<string, unknown>;
          },
        );
        let image: string | undefined;
        if (!draft && result['binary'] && /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(path)) {
          const preview = await command('files.image', { filePath: path }, ['files.image']);
          if (
            typeof preview['dataUrl'] === 'string' &&
            /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/.test(preview['dataUrl'])
          )
            image = preview['dataUrl'];
        }
        const content = String(result['content'] ?? '');
        setDocuments((docs) => ({
          ...docs,
          [path]: {
            content: draft?.content ?? content,
            saved: draft?.saved ?? content,
            binary: !draft && result['binary'] === true,
            tooLarge: !draft && result['tooLarge'] === true,
            editing: !!draft,
            ...(image ? { image } : {}),
          },
        }));
      } catch (error) {
        if (activeFile.current === path)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        fileReads.current.delete(path);
        setLoading((current) => (current === path ? '' : current));
      }
    },
    [command, scopeKey, draftStore],
  );
  useEffect(() => {
    if (mode === 'files' && active && !docs.current[active]) void openFile(active);
  }, [mode, active, openFile]);
  useEffect(() => {
    const identity = `${key}\0${initialPath}\0${initialLine ?? ''}\0${initialEndLine ?? ''}`;
    const knownFile = initialPathIsFile && mode === 'files';
    if (
      !initialPath ||
      (!knownFile && (!treeReady || treeFilter !== includeIgnored)) ||
      revealed.current === identity
    )
      return;
    const path = projectRelativePath(initialPath, scopeKey);
    if (!knownFile && !all.some((node) => node.path === path) && !includeIgnored) {
      setIncludeIgnored(true);
      return;
    }
    revealed.current = identity;
    if (!knownFile && all.find((node) => node.path === path)?.type === 'directory') {
      setFolder(path);
      setActive('');
      setSelected(path);
      setExpanded((paths) => [
        ...new Set([
          ...paths,
          ...path.split('/').map((_, index) =>
            path
              .split('/')
              .slice(0, index + 1)
              .join('/'),
          ),
        ]),
      ]);
    } else {
      void openFile(path);
      if (initialLine && initialLine > 0)
        setSearchSelection({
          path,
          line: initialLine,
          ...(initialEndLine && initialEndLine > initialLine ? { endLine: initialEndLine } : {}),
          id: crypto.randomUUID(),
        });
    }
  }, [
    initialPath,
    initialPathIsFile,
    mode,
    initialLine,
    initialEndLine,
    openFile,
    key,
    treeReady,
    treeFilter,
    includeIgnored,
    all,
    scopeKey,
  ]);
  const refreshDiff = useCallback(() => {
    if (!active) {
      setDiff(null);
      return;
    }
    const path = asGitPath(active);
    let current = true;
    setDiff(null);
    void command('git.diff', { path }, ['git.diff'])
      .then((result) => {
        if (current) setDiff(result);
      })
      .catch((error: unknown) => {
        if (current) setDiff({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
    };
  }, [active, asGitPath, command]);
  useEffect(() => refreshDiff(), [refreshDiff]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const persistDocument = async (path: string, document: Document) => {
    if (document.binary || document.tooLarge) return;
    try {
      await draftStore.write(path, document.content, document.saved);
      await refreshDrafts();
    } catch (error) {
      setError(t('fileView.draftNotSaved', { error: String(error) }));
      if (String(error).includes('DRAFT_CONFLICT'))
        setDraftConflict({ path, snapshot: await draftStore.inspect(path) });
    }
  };
  const updateDocument = (path: string, patch: Partial<Document>) => {
    const previous = docs.current[path];
    if (!previous) return;
    const document = { ...previous, ...patch };
    docs.current = { ...docs.current, [path]: document };
    setDocuments(docs.current);
    if ('content' in patch || 'saved' in patch)
      void persistDocument(path, document).catch((error: unknown) => setError(String(error)));
  };
  /** `overwrite` is the hash of the disk version the user chose to replace. */
  const save = async (path: string, overwrite?: string) => {
    const document = docs.current[path];
    if (!document) return;
    try {
      await draftStore.verify(path);
    } catch (error) {
      if (String(error).includes('DRAFT_CONFLICT'))
        setDraftConflict({ path, snapshot: await draftStore.inspect(path) });
      throw error;
    }
    const outcome = await saveFileVersion(
      command,
      path,
      document.content,
      document.saved,
      overwrite,
    );
    if (outcome.kind === 'conflict') {
      setAction({ kind: 'conflict', path, ...(outcome.sha256 ? { sha256: outcome.sha256 } : {}) });
      return;
    }
    updateDocument(path, { saved: document.content });
    setNotice(t('fileView.saved', { name: fileName(path) }));
    await reload();
    refreshDiff();
  };
  const close = (path: string, discard = false) => {
    const document = docs.current[path];
    if (!discard && document && document.content !== document.saved) {
      setAction({ kind: 'close', path });
      return;
    }
    if (discard && document && document.content !== document.saved) {
      void run(async () => {
        await draftStore.verify(path);
        await draftStore.write(path, document.saved, document.saved);
        docs.current = { ...docs.current, [path]: { ...document, content: document.saved } };
        setDocuments(docs.current);
        close(path);
        await refreshDrafts();
      });
      return;
    }
    draftStore.forget(path);
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (active === path)
      setActive(
        Object.keys(docs.current)
          .filter((p) => p !== path)
          .at(-1) ?? '',
      );
    setAction(null);
  };
  const startAction = (kind: Action['kind'], path = active) => {
    setMenu(null);
    setError('');
    setValue(
      kind === 'rename'
        ? path
        : kind === 'move'
          ? parentPath(path)
          : kind === 'file' || kind === 'directory'
            ? `${folder ? `${folder}/` : ''}`
            : '',
    );
    setAction({ kind, path });
  };
  const {
    relocate,
    hasUnsaved,
    removePath,
    batchFiles,
    batchCopy,
    copyMany,
    moveMany,
    removeMany,
    movePath,
    copyPath,
    renamePath,
  } = createFileWorkspaceOperations({
    command,
    all,
    docs,
    setDocuments,
    setActive,
    setFolder,
    state,
    t,
  });
  const confirm = () =>
    run(async () => {
      if (!action) return;
      const path = action.path;
      if (action.kind === 'file' || action.kind === 'directory') {
        await command('files.create', { filePath: value.trim(), type: action.kind }, [
          'files.created',
        ]);
        if (action.kind === 'file') await openFile(value.trim());
        else {
          setFolder(value.trim());
          setExpanded((paths) => [...paths, value.trim()]);
        }
      }
      if (action.kind === 'rename' || action.kind === 'move') {
        if (hasUnsaved(path)) throw new Error(t('fileView.saveBeforeMove'));
        const result =
          action.kind === 'rename'
            ? await command('files.rename', { oldPath: path, newPath: value.trim() }, [
                'files.renamed',
              ])
            : await command('files.move', { srcPath: path, destDir: value.trim() || '.' }, [
                'files.moved',
              ]);
        relocate(path, String(result['newPath'] ?? result['destPath'] ?? value.trim()));
      }
      if (action.kind === 'delete') {
        await removePath(path);
      }
      if (action.kind === 'discard') {
        await command('git.discard', { paths: [asGitPath(path)] }, ['git.action_result']);
        const result = await command('files.read', { filePath: path }, ['files.read']);
        updateDocument(path, {
          content: String(result['content'] ?? ''),
          saved: String(result['content'] ?? ''),
        });
        refreshDiff();
      }
      if (action.kind === 'commit') {
        await command('git.commit', { message: value.trim() }, ['git.action_result']);
        setNotice(t('fileView.committed'));
      }
      if (action.kind === 'comment')
        await reviewNotes.store.save([
          ...notes,
          { path, line: action.line ?? 1, text: value.trim() },
        ]);
      await (action.kind === 'comment' ? refresh() : reload());
      setAction(null);
    });
  // `null` is the whole group: the engine reads no paths as "all" (`git add -A -- .`), so a
  // large working tree never becomes one oversized command line.
  const stage = (path: string | null, staged: boolean) =>
    run(async () => {
      const paths = path === null ? [] : [asGitPath(path)];
      await command(staged ? 'git.unstage' : 'git.stage', { paths }, ['git.action_result']);
      await reload();
      refreshDiff();
    });
  const document = documents[active];
  useEffect(() => {
    if (
      !searchSelection ||
      searchSelection.path !== active ||
      !document ||
      searchRevealed.current === searchSelection.id
    )
      return;
    const root = contentElement.current;
    if (!root) return;
    const editor = root.querySelector('textarea');
    if (editor) {
      const offset = document.content
        .split('\n')
        .slice(0, searchSelection.line - 1)
        .reduce((total, line) => total + line.length + 1, 0);
      editor.focus();
      const lines = document.content.split('\n');
      const last = searchSelection.endLine ?? searchSelection.line;
      const end = lines
        .slice(searchSelection.line - 1, last)
        .reduce((total, line) => total + line.length + 1, offset - 1);
      editor.setSelectionRange(offset, Math.min(document.content.length, Math.max(offset, end)));
      editor.scrollTop = Math.max(
        0,
        (searchSelection.line - 4) * (Number.parseFloat(getComputedStyle(editor).lineHeight) || 20),
      );
    } else
      root
        .querySelector(`[data-source-line="${searchSelection.line}"]`)
        ?.scrollIntoView({ block: 'center' });
    searchRevealed.current = searchSelection.id;
  }, [searchSelection, active, document]);
  const isDirty = Boolean(document && document.content !== document.saved);
  const children = folder ? (all.find((node) => node.path === folder)?.children ?? []) : tree;
  const visible = (
    search ? all.filter((node) => node.path.toLowerCase().includes(search.toLowerCase())) : children
  ).toSorted((a, b) =>
    a.type !== b.type
      ? a.type === 'directory'
        ? -1
        : 1
      : sort === 'size'
        ? (b.size ?? 0) - (a.size ?? 0)
        : a.name.localeCompare(b.name),
  );
  const change = changes.find((file) => file['path'] === asGitPath(active));
  const [selected, setSelected] = useState('');
  // Large folders list a page at a time; the tree beside them is virtualized.
  const [folderLimit, setFolderLimit] = useState(FOLDER_PAGE);
  // Items picked for a bulk move or delete in the folder listing.
  const [picked, setPicked] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [bulk, setBulk] = useState<'move' | 'copy' | 'rename' | 'delete' | null>(null);
  // Find and replace in the open editor (Ctrl/Cmd+F).
  const [finding, setFinding] = useState(false);
  // Caret for a key edit, applied once React has written the new text into the textarea;
  // setting it earlier is lost when the controlled value re-renders.
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const editingContent = document?.editing ? document.content : undefined;
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const input = contentElement.current?.querySelector<HTMLTextAreaElement>(
      'textarea.file-code-editor',
    );
    if (!selection || !input || input.value !== editingContent) return;
    pendingSelection.current = null;
    input.setSelectionRange(selection.start, selection.end);
  }, [editingContent]);
  // Find in the read-only source view; matching lines are marked, the current one scrolled to.
  const [viewerFind, setViewerFind] = useState<ViewerFind | null>(null);
  const closeViewerFind = useCallback(() => setViewerFind(null), []);
  const updateViewerFind = useCallback((find: ViewerFind) => setViewerFind(find), []);
  useEffect(() => setViewerFind(null), [active]);
  useEffect(() => {
    if (!viewerFind?.current) return;
    contentElement.current
      ?.querySelector(`[data-source-line="${viewerFind.current}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [viewerFind?.current]);
  // A new folder, search or sort starts again at the first page.
  useEffect(() => setFolderLimit(FOLDER_PAGE), [folder, search, sort]);
  // Leaving the folder or search drops a selection the listing no longer shows.
  useEffect(() => setPicked([]), [folder, search]);
  const togglePick = (path: string) =>
    setPicked((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  const referenceSelection = (quote: boolean) => {
    const root = contentElement.current;
    if (!onReference || !document || !active || !root) return;
    const result = selectionReference(active, document, root, quote);
    if ('error' in result) setError(result.error);
    else onReference(result.reference);
  };
  const review = () => {
    const text = reviewText(notes);
    if (onReview) onReview(text);
    else
      void navigator.clipboard
        ?.writeText(text)
        .then(() => setNotice(t('fileView.reviewCopied')))
        .catch(() => {});
  };

  return {
    command,
    mode,
    onReview,
    onReference,
    send,
    state,
    key,
    t,
    tree,
    git,
    documents,
    setDocuments,
    active,
    setActive,
    folder,
    setFolder,
    expanded,
    setExpanded,
    search,
    setSearch,
    loading,
    treeLoading,
    busy,
    plainEditor,
    setPlainEditor,
    error,
    setError,
    notice,
    setNotice,
    diff,
    action,
    setAction,
    value,
    setValue,
    hunkReview,
    setHunkReview,
    mergeReview,
    setMergeReview,
    menu,
    setMenu,
    sort,
    setSort,
    history,
    setHistory,
    includeIgnored,
    setIncludeIgnored,
    treeCollapsed,
    setTreeCollapsed,
    treePanelId,
    reviewNotes,
    notes,
    contentElement,
    contentSearch,
    setContentSearch,
    searchSelection,
    setSearchSelection,
    draftStore,
    recoverable,
    draftConflict,
    setDraftConflict,
    refreshDrafts,
    docs,
    all,
    prefix,
    changes,
    asGitPath,
    fromGitPath,
    refresh,
    reload,
    openFile,
    refreshDiff,
    run,
    updateDocument,
    save,
    close,
    startAction,
    hasUnsaved,
    removePath,
    batchFiles,
    batchCopy,
    copyMany,
    moveMany,
    removeMany,
    movePath,
    copyPath,
    renamePath,
    confirm,
    stage,
    document,
    isDirty,
    visible,
    change,
    selected,
    setSelected,
    folderLimit,
    setFolderLimit,
    picked,
    setPicked,
    selecting,
    setSelecting,
    bulk,
    setBulk,
    finding,
    setFinding,
    pendingSelection,
    viewerFind,
    setViewerFind,
    closeViewerFind,
    updateViewerFind,
    togglePick,
    referenceSelection,
    review,
    FOLDER_PAGE,
  };
}
