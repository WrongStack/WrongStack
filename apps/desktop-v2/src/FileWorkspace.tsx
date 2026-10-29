import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Eye,
  File,
  FileCode2,
  FileDiff,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutList,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Quote,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerFileReference } from './composer-resources-model';
import { DiffPreview } from './DiffPreview';
import { EditorFindBar } from './EditorFindBar';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries } from './engine-values';
import { FileBulkDialog } from './FileBulkDialog';
import { FileContentSearch } from './FileContentSearch';
import { FileEvidenceDrawer } from './FileEvidenceDrawer';
import { FileTreeView } from './FileTreeView';
import { relocatedPath } from './file-bulk';
import { type FileDraftSnapshot, FileDraftStore } from './file-draft';
import {
  byteSize,
  type FileNode,
  fileLanguage,
  fileName,
  fileTree,
  flattenFiles,
  parentPath,
  projectRelativePath,
  reviewText,
} from './file-model';
import { selectionReference } from './file-selection-reference';
import { GitHistory } from './GitHistory';
import { GitHunkReview } from './GitHunkReview';
import { MergeConflictReview } from './MergeConflictReview';
import { Modal } from './Modal';
import { useReviewNotes } from './useReviewNotes';
import './file-draft.css';
import { saveFileVersion } from './file-save';
import { fileDraftStorage, request } from './platform';

interface Document {
  content: string;
  saved: string;
  binary: boolean;
  tooLarge: boolean;
  image?: string;
  editing: boolean;
}
interface ReviewNote {
  path: string;
  line: number;
  text: string;
}
interface Chrome {
  documents: Record<string, Document>;
  active: string;
  folder: string;
  expanded: string[];
  notes: ReviewNote[];
  includeIgnored: boolean;
}
const chrome = new Map<string, Chrome>();
// A window retains the same draft revisions when its project tools remount.
// Other native windows have independent stores and must still pass the SQLite revision check.
const fileDraftStores = new Map<string, FileDraftStore>();
const FOLDER_PAGE = 200;
type Action = {
  kind:
    | 'file'
    | 'directory'
    | 'rename'
    | 'move'
    | 'delete'
    | 'close'
    | 'conflict'
    | 'discard'
    | 'commit'
    | 'comment';
  path: string;
  line?: number;
  /** Disk version shown in a conflict review; overwrite replaces only this version. */
  sha256?: string;
};
export function FileWorkspace({
  command,
  scopeKey,
  projectId,
  mode = 'files',
  initialPath = '',
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
  const [tree, setTree] = useState<FileNode[]>([]),
    [git, setGit] = useState<Record<string, unknown>>({}),
    [documents, setDocuments] = useState<Record<string, Document>>(cached?.documents ?? {}),
    [active, setActive] = useState(cached?.active ?? ''),
    [folder, setFolder] = useState(cached?.folder ?? ''),
    [expanded, setExpanded] = useState<string[]>(cached?.expanded ?? []),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(''),
    [busy, setBusy] = useState(false),
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
    [treeFilter, setTreeFilter] = useState<boolean | null>(null);
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
  docs.current = documents;
  useEffect(() => {
    chrome.set(key, { documents, active, folder, expanded, notes, includeIgnored });
  }, [key, documents, active, folder, expanded, notes, includeIgnored]);
  const all = useMemo(() => flattenFiles(tree), [tree]);
  const prefix = typeof git['repoPrefix'] === 'string' ? git['repoPrefix'] : '';
  const changes = entries(git['files']).filter((file) => String(file['path']).startsWith(prefix));
  const asGitPath = useCallback((path: string) => `${prefix}${path}`, [prefix]);
  const fromGitPath = (path: string) =>
    prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      command('files.tree', { includeIgnored }, ['files.tree']),
      command('git.changes', {}, ['git.changes']),
    ]);
    if (results[0].status === 'fulfilled') {
      setTree(fileTree(results[0].value['tree']));
      setTreeReady(true);
      setTreeFilter(includeIgnored);
    } else throw results[0].reason;
    if (results[1].status === 'fulfilled') setGit(results[1].value);
    else
      setGit({
        error:
          results[1].reason instanceof Error
            ? results[1].reason.message
            : String(results[1].reason),
      });
  }, [command, includeIgnored]);
  useEffect(() => {
    setLoading('tree');
    void refresh()
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(''));
  }, [refresh]);
  const openFile = useCallback(
    async (rawPath: string) => {
      const path = projectRelativePath(rawPath, scopeKey);
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
      if (docs.current[path] || fileReads.current.has(path)) return;
      fileReads.current.add(path);
      setLoading(path);
      try {
        const draft = (await draftStore.load(path)).value;
        const result = await command('files.read', { filePath: path }, ['files.read']).catch(
          (error: unknown) => {
            if (!draft) throw error;
            setNotice(
              'The source file is unavailable. Your recovered draft is preserved; copy it before recreating the file.',
            );
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
    const identity = `${key}\0${initialPath}`;
    if (
      !initialPath ||
      !treeReady ||
      treeFilter !== includeIgnored ||
      revealed.current === identity
    )
      return;
    const path = projectRelativePath(initialPath, scopeKey);
    if (!all.some((node) => node.path === path) && !includeIgnored) {
      setIncludeIgnored(true);
      return;
    }
    revealed.current = identity;
    if (all.find((node) => node.path === path)?.type === 'directory') {
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
    } else void openFile(path);
  }, [initialPath, openFile, key, treeReady, treeFilter, includeIgnored, all, scopeKey]);
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
      setError(`Local draft was not saved: ${String(error)}. Your editor text is still available.`);
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
    setNotice(`Saved ${fileName(path)}.`);
    await refresh();
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
  /** Open documents, the active file and the folder follow an item to its new path. */
  const relocate = (path: string, nextPath: string) => {
    setDocuments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([p, doc]) => [relocatedPath(p, path, nextPath) ?? p, doc]),
      ),
    );
    setActive((current) => relocatedPath(current, path, nextPath) ?? current);
    setFolder((current) => relocatedPath(current, path, nextPath) ?? current);
  };
  const hasUnsaved = (path: string) =>
    Object.entries(docs.current).some(
      ([p, d]) => relocatedPath(p, path, p) !== null && d.content !== d.saved,
    );
  const removePath = async (path: string) => {
    await command(
      'files.delete',
      { filePath: path, recursive: all.find((n) => n.path === path)?.type === 'directory' },
      ['files.deleted'],
    );
    setDocuments((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([p]) => relocatedPath(p, path, p) === null),
      ),
    );
    setActive((current) => (relocatedPath(current, path, '') === null ? current : ''));
    setFolder((current) =>
      relocatedPath(current, path, '') === null ? current : parentPath(path),
    );
  };
  const movePath = async (path: string, destination: string) => {
    const result = await command('files.move', { srcPath: path, destDir: destination }, [
      'files.moved',
    ]);
    relocate(path, String(result['destPath'] ?? result['newPath'] ?? ''));
  };
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
        if (hasUnsaved(path))
          throw new Error('Save or close edited files before moving this item.');
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
        setNotice('Commit created from staged changes.');
      }
      if (action.kind === 'comment')
        await reviewNotes.store.save([
          ...notes,
          { path, line: action.line ?? 1, text: value.trim() },
        ]);
      await refresh();
      setAction(null);
    });
  const stage = (path: string, staged: boolean) =>
    run(async () => {
      await command(staged ? 'git.unstage' : 'git.stage', { paths: [asGitPath(path)] }, [
        'git.action_result',
      ]);
      await refresh();
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
      editor.setSelectionRange(
        offset,
        Math.min(
          document.content.length,
          offset + (document.content.split('\n')[searchSelection.line - 1]?.length ?? 0),
        ),
      );
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
  const [bulk, setBulk] = useState<'move' | 'delete' | null>(null);
  // Find and replace in the open editor (Ctrl/Cmd+F).
  const [finding, setFinding] = useState(false);
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
    else void navigator.clipboard.writeText(text).then(() => setNotice('Review copied.'));
  };
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
      aria-label={mode === 'changes' ? 'Repository changes' : 'Project file manager'}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && active) {
          event.preventDefault();
          if (isDirty && !busy) void run(() => save(active));
        }
      }}
    >
      <header className="file-workspace-toolbar">
        <div className="file-workspace-location">
          {mode === 'changes' ? <GitBranch size={16} /> : <FolderOpen size={16} />}
          <strong>{mode === 'changes' ? 'Changes & review' : 'Files'}</strong>
          <span>
            {mode === 'changes' ? `${changes.length} changed files` : 'Project workspace'}
          </span>
        </div>
        <div className="file-workspace-search">
          <Search size={14} />
          <input
            aria-label="Search project files"
            placeholder="Find a file or folder…"
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
            Search contents
          </button>
        )}
        <button type="button" className="button secondary small" onClick={() => setHistory(true)}>
          <GitBranch size={13} />
          History
        </button>
        {mode === 'files' ? (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label="New file"
              title="New file"
              onClick={() => startAction('file')}
            >
              <FilePlus2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="New folder"
              title="New folder"
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
            Commit staged
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh file manager"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Show ignored source files"
          title="Show Git-ignored source files"
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
            setNotice(
              `Search match: ${path}, line ${line}. Search results reflect saved files; an open draft may differ.`,
            );
          }}
        />
      )}
      {error && (
        <p className="file-workspace-error" role="alert">
          {error}
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
          <summary>{recoverable.length} local file drafts · saved on this device</summary>
          <p>
            These edits have not been written to project files. Open a draft to review or save it.
            {recoverable.length === 500 &&
              ' Showing the most recent 500 drafts; other drafts remain stored and are recovered when their file is opened.'}
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
      {bulk && (
        <FileBulkDialog
          kind={bulk}
          paths={picked}
          initialTarget={folder}
          isDirectory={(path) => all.find((node) => node.path === path)?.type === 'directory'}
          hasUnsaved={hasUnsaved}
          move={movePath}
          remove={removePath}
          onClose={() => setBulk(null)}
          onFinished={(summary, changed) => {
            setBulk(null);
            setPicked((current) => current.filter((path) => !changed.includes(path)));
            setNotice(summary);
            void refresh();
          }}
        />
      )}
      {draftConflict && (
        <Modal
          onClose={() => {
            if (!busy) setDraftConflict(null);
          }}
        >
          <div className="file-draft-comparison">
            <h2 id="dialog-title">File draft changed in another window</h2>
            <p>
              <strong>{draftConflict.path}</strong>
            </p>
            <p>
              Compare the saved local draft with your editor before choosing which version to keep.
              Project files are unchanged.
            </p>
            <div className="file-draft-versions">
              <label>
                Your editor
                <textarea
                  aria-label="Your editor"
                  readOnly
                  value={documents[draftConflict.path]?.content ?? ''}
                />
              </label>
              <label>
                Stored draft
                <textarea
                  aria-label="Stored draft"
                  readOnly
                  value={
                    draftConflict.snapshot.value?.content ?? 'No unsaved draft remains in storage.'
                  }
                />
              </label>
            </div>
            {error && (
              <p role="alert" className="file-workspace-error">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setDraftConflict(null)}
              >
                Keep editing locally
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { path, snapshot } = draftConflict;
                    const document = docs.current[path];
                    if (!document) return;
                    try {
                      await draftStore.resolve(
                        path,
                        snapshot.revision,
                        document.content,
                        document.saved,
                      );
                    } catch (error) {
                      if (String(error).includes('DRAFT_CONFLICT'))
                        setDraftConflict({ path, snapshot: await draftStore.inspect(path) });
                      throw error;
                    }
                    setDraftConflict(null);
                    await refreshDrafts();
                    setNotice(
                      'Your local version is now stored as a draft. Project files are unchanged.',
                    );
                  })
                }
              >
                Keep my draft
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { path, snapshot } = draftConflict;
                    const latest = await draftStore.inspect(path);
                    if (latest.revision !== snapshot.revision) {
                      setDraftConflict({ path, snapshot: latest });
                      throw Error('The stored draft changed again. Review the latest version.');
                    }
                    draftStore.forget(path);
                    delete docs.current[path];
                    setDocuments({ ...docs.current });
                    setDraftConflict(null);
                    await openFile(path);
                  })
                }
              >
                Use stored draft
              </button>
            </footer>
          </div>
        </Modal>
      )}
      <div className="file-workspace-body">
        <aside className="file-navigation">
          <header>
            <span>{mode === 'files' ? 'EXPLORER' : 'SOURCE CONTROL'}</span>
            {mode === 'files' && (
              <button
                type="button"
                aria-label="Collapse all folders"
                onClick={() => setExpanded([])}
              >
                <LayoutList size={13} />
              </button>
            )}
          </header>
          {loading === 'tree' ? (
            <div className="file-quiet-state">
              <LoaderCircle size={16} className="spin" />
              Reading project…
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
                  x: Math.min(event.clientX, innerWidth - 210),
                  y: Math.min(event.clientY, innerHeight - 220),
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
                        {group}
                        <span>{rows.length}</span>
                      </h3>
                      {rows.map((file) => (
                        <div
                          className={`file-change-row ${active === fromGitPath(String(file['path'])) ? 'selected' : ''}`}
                          key={String(file['path'])}
                        >
                          <button
                            type="button"
                            aria-label={`Review ${String(file['path'])}`}
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
                              <strong>{fileName(String(file['path']))}</strong>
                              <small>{parentPath(String(file['path'])) || 'Project root'}</small>
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
                            aria-label={`${file['staged'] ? 'Unstage' : 'Stage'} ${String(file['path'])}`}
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
                <p className="file-quiet-state">No uncommitted changes.</p>
              )}
            </div>
          )}
          <footer>
            {all.filter((n) => n.type === 'file').length} visible files
            <span>
              {includeIgnored ? 'Ignored source files included' : 'Ignored paths are excluded'}
            </span>
          </footer>
        </aside>
        <div className="file-center">
          <nav className="file-open-tabs" aria-label="Open files">
            <button
              type="button"
              className={!active ? 'file-tab-current' : ''}
              onClick={() => setActive('')}
            >
              <FolderOpen size={13} />
              Explorer
            </button>
            {Object.entries(documents).map(([path, doc]) => (
              <div className={active === path ? 'file-tab-current' : ''} key={path}>
                <button
                  type="button"
                  aria-label={`Open file tab ${path}`}
                  title={path}
                  onClick={() => setActive(path)}
                >
                  <FileCode2 size={13} />
                  {fileName(path)}
                  {doc.content !== doc.saved && <span className="file-unsaved-dot" />}
                </button>
                <button type="button" aria-label={`Close ${path}`} onClick={() => close(path)}>
                  <X size={12} />
                </button>
              </div>
            ))}
            {active && !documents[active] && (
              <div className="file-tab-current">
                <button
                  type="button"
                  aria-label={`Open file tab ${active}`}
                  title={active}
                  onClick={() => setActive(active)}
                >
                  <FileDiff size={13} />
                  {fileName(active)}
                </button>
                <button type="button" aria-label={`Close ${active}`} onClick={() => setActive('')}>
                  <X size={12} />
                </button>
              </div>
            )}
          </nav>
          {active ? (
            <>
              <div className="file-document-toolbar">
                <span className="file-document-path" title={active}>
                  {active}
                </span>
                <span className="file-document-language">{fileLanguage(active)}</span>
                {document && !document.binary && !document.tooLarge && mode === 'files' && (
                  <button
                    type="button"
                    aria-pressed={document.editing}
                    onClick={() => updateDocument(active, { editing: !document.editing })}
                  >
                    <Pencil size={13} />
                    {document.editing ? 'Read view' : 'Edit file'}
                  </button>
                )}
                {change && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stage(active, Boolean(change['staged']))}
                  >
                    {change['staged'] ? 'Unstage' : 'Stage'}
                  </button>
                )}
                {mode === 'files' && onReference && document && !document.binary && (
                  <button
                    type="button"
                    className="button secondary small"
                    title="Attach this file, or the selected lines, to the conversation"
                    // Keep the current text selection while the button is pressed.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => referenceSelection(false)}
                  >
                    <FilePlus2 size={13} />
                    Reference in conversation
                  </button>
                )}
                {mode === 'files' && onReference && document && !document.binary && (
                  <button
                    type="button"
                    className="button secondary small"
                    title="Attach the selected text itself to the conversation"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => referenceSelection(true)}
                  >
                    <Quote size={13} />
                    Quote selection
                  </button>
                )}
                {mode === 'files' && (
                  <button
                    type="button"
                    className="file-save-button"
                    disabled={!isDirty || busy}
                    onClick={() => void run(() => save(active))}
                  >
                    <Save size={13} />
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="File actions"
                  onClick={(event) =>
                    setMenu({
                      path: active,
                      x: Math.min(event.clientX, innerWidth - 210),
                      y: Math.min(event.clientY, innerHeight - 220),
                    })
                  }
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
              <div className="file-document native-file-content" ref={contentElement}>
                {mode === 'changes' && change?.['status'] === 'U' && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setMergeReview(true)}
                  >
                    Resolve merge conflict
                  </button>
                )}
                {loading === active && !document ? (
                  <div className="file-quiet-state">
                    <LoaderCircle size={20} className="spin" />
                    Reading {fileName(active)}…
                  </div>
                ) : mode === 'changes' ? (
                  diff?.['error'] ? (
                    <p className="file-quiet-state">{String(diff['error'])}</p>
                  ) : diff?.['binary'] || diff?.['tooLarge'] ? (
                    <p className="file-quiet-state">
                      {diff['binary']
                        ? 'Binary file — text review is unavailable.'
                        : 'File exceeds the text review limit.'}
                    </p>
                  ) : diff ? (
                    <>
                      {change?.['status'] !== 'U' && (
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          onClick={() => setHunkReview(true)}
                        >
                          Review & stage hunks
                        </button>
                      )}
                      <DiffPreview
                        before={String(diff['oldText'] ?? '')}
                        after={String(diff['newText'] ?? '')}
                        path={active}
                        onComment={(line) => {
                          setAction({ kind: 'comment', path: active, line });
                          setValue('');
                        }}
                      />
                    </>
                  ) : (
                    <p className="file-quiet-state">Reading repository changes…</p>
                  )
                ) : document?.image ? (
                  <div className="file-image-preview">
                    <img src={document.image} alt={fileName(active)} />
                    <span>{fileName(active)}</span>
                  </div>
                ) : document?.binary || document?.tooLarge ? (
                  <div className="file-quiet-state">
                    <File size={32} />
                    <h3>{document.binary ? 'Binary file' : 'File is too large for the editor'}</h3>
                    <p>Your file stays on disk. Text editing is unavailable.</p>
                  </div>
                ) : document?.editing ? (
                  <>
                    {finding && (
                      <EditorFindBar
                        content={document.content}
                        editor={() =>
                          contentElement.current?.querySelector<HTMLTextAreaElement>(
                            'textarea.file-code-editor',
                          ) ?? null
                        }
                        onChange={(text, select) => {
                          updateDocument(active, { content: text });
                          if (select)
                            requestAnimationFrame(() =>
                              contentElement.current
                                ?.querySelector<HTMLTextAreaElement>('textarea.file-code-editor')
                                ?.setSelectionRange(select.start, select.end),
                            );
                        }}
                        onClose={() => setFinding(false)}
                      />
                    )}
                    <textarea
                      className="file-code-editor"
                      aria-label={`Edit ${active}`}
                      spellCheck={false}
                      value={document.content}
                      onChange={(event) => updateDocument(active, { content: event.target.value })}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                          event.preventDefault();
                          setFinding(true);
                          return;
                        }
                        if (event.key === 'Tab') {
                          event.preventDefault();
                          const input = event.currentTarget,
                            start = input.selectionStart,
                            end = input.selectionEnd;
                          updateDocument(active, {
                            content:
                              document.content.slice(0, start) + '  ' + document.content.slice(end),
                          });
                          requestAnimationFrame(() => {
                            input.selectionStart = input.selectionEnd = start + 2;
                          });
                        }
                      }}
                    />
                  </>
                ) : document ? (
                  <section className="file-source-code" aria-label={`Source of ${active}`}>
                    {document.content.split('\n').map((line, index) => (
                      <div
                        className={`file-source-line${searchSelection?.path === active && searchSelection.line === index + 1 ? ' search-match' : ''}`}
                        data-source-line={index + 1}
                        key={index}
                      >
                        <span aria-hidden="true">{index + 1}</span>
                        <code>
                          <HighlightLine text={line} />
                        </code>
                      </div>
                    ))}
                  </section>
                ) : (
                  <p className="file-quiet-state">Select another file or refresh to retry.</p>
                )}
              </div>
              {document && mode === 'files' && (
                <FileEvidenceDrawer
                  key={active}
                  path={active}
                  content={document.content}
                  saved={document.saved}
                  {...(all.find((n) => n.path === active)?.size !== undefined
                    ? { size: all.find((n) => n.path === active)!.size }
                    : {})}
                  command={command}
                  send={send}
                  state={state}
                  diff={diff}
                  refreshDiff={refreshDiff}
                />
              )}
            </>
          ) : (
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
                  Project
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
                  {selecting ? 'Done selecting' : 'Select items'}
                </button>
                <select
                  aria-label="Sort files"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                </select>
              </div>
              <div className="file-folder-list">
                {picked.length > 0 && (
                  <div className="file-bulk-bar" role="toolbar" aria-label="Selected items">
                    <span>{picked.length} selected</span>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy}
                      onClick={() => setBulk('move')}
                    >
                      Move selected…
                    </button>
                    <button
                      type="button"
                      className="button secondary small danger"
                      disabled={busy}
                      onClick={() => setBulk('delete')}
                    >
                      Delete selected…
                    </button>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => setPicked([])}
                    >
                      Clear selection
                    </button>
                  </div>
                )}
                <div className="file-folder-list-heading">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Size</span>
                </div>
                {folder && !search && (
                  <button
                    type="button"
                    className="file-parent-row"
                    onClick={() => setFolder(parentPath(folder))}
                  >
                    <ArrowLeft size={14} />
                    Parent folder
                  </button>
                )}
                {visible.slice(0, folderLimit).map((node) => (
                  <button
                    type="button"
                    className={`file-folder-row${picked.includes(node.path) ? ' picked' : ''}`}
                    key={node.path}
                    aria-label={`${selecting ? 'Select' : 'Open'} ${node.path}`}
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
                        x: Math.min(event.clientX, innerWidth - 210),
                        y: Math.min(event.clientY, innerHeight - 220),
                      });
                    }}
                  >
                    <span>
                      {picked.includes(node.path) ? (
                        <Check size={17} aria-hidden="true" />
                      ) : node.type === 'directory' ? (
                        <Folder size={17} />
                      ) : (
                        <FileCode2 size={17} />
                      )}
                      <span>
                        {node.name}
                        {search && <small>{parentPath(node.path)}</small>}
                      </span>
                    </span>
                    <span>{node.type === 'directory' ? 'Folder' : fileLanguage(node.path)}</span>
                    <span>{node.size === undefined ? '—' : byteSize(node.size)}</span>
                  </button>
                ))}
                {visible.length > folderLimit && (
                  <button
                    type="button"
                    className="file-parent-row"
                    onClick={() => setFolderLimit((limit) => limit + FOLDER_PAGE)}
                  >
                    Show {Math.min(FOLDER_PAGE, visible.length - folderLimit)} more ·{' '}
                    {visible.length - folderLimit} not shown
                  </button>
                )}
                {!visible.length && (
                  <div className="file-quiet-state">
                    <FolderOpen size={30} />
                    <h3>{search ? 'No files match this search' : 'This folder is empty'}</h3>
                    {!search && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => startAction('file')}
                      >
                        Create a file
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {mode === 'changes' && (
            <section className="file-review-tray">
              <header>
                <strong>{notes.length} review notes</strong>
                <button
                  type="button"
                  disabled={reviewNotes.busy}
                  onClick={() => void reviewNotes.store.load()}
                >
                  Reload saved review notes
                </button>
                <button type="button" onClick={review}>
                  <Copy size={13} />
                  {onReview ? 'Use in conversation' : 'Copy review'}
                </button>
              </header>
              {reviewNotes.error && <p role="alert">{reviewNotes.error}</p>}
              <small>
                {reviewNotes.busy
                  ? 'Saving or loading review notes…'
                  : reviewNotes.ready
                    ? 'Saved per project on this desktop. Line anchors refer to the reviewed file version.'
                    : 'Review notes are unavailable.'}
              </small>
              <div>
                {notes.map((note, index) => (
                  <article key={index}>
                    <span>
                      {note.path}:{note.line}
                    </span>
                    <p>{note.text}</p>
                    <button
                      type="button"
                      aria-label={`Remove review note ${index + 1}`}
                      disabled={!reviewNotes.ready || reviewNotes.busy}
                      onClick={() =>
                        void run(() => reviewNotes.store.save(notes.filter((_, i) => i !== index)))
                      }
                    >
                      <X size={12} />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {hunkReview && active && (
        <GitHunkReview
          path={asGitPath(active)}
          command={command}
          onClose={() => setHunkReview(false)}
          onApplied={() => {
            void refresh();
            refreshDiff();
          }}
        />
      )}
      {mergeReview && active && (
        <MergeConflictReview
          path={asGitPath(active)}
          command={command}
          onClose={() => setMergeReview(false)}
          onResolved={() => {
            void refresh();
            refreshDiff();
          }}
        />
      )}
      {menu && (
        <>
          <button
            type="button"
            className="file-context-dismiss"
            aria-label="Close file menu"
            onClick={() => setMenu(null)}
          />
          <div className="file-context-menu" style={{ left: menu.x, top: menu.y }}>
            <small>{fileName(menu.path)}</small>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(menu.path);
                setMenu(null);
              }}
            >
              <Copy size={14} />
              Copy path
            </button>
            <button type="button" onClick={() => startAction('rename', menu.path)}>
              <Pencil size={14} />
              Rename
            </button>
            <button type="button" onClick={() => startAction('move', menu.path)}>
              <FolderOpen size={14} />
              Move to folder
            </button>
            {changes.some((file) => file['path'] === asGitPath(menu.path)) && (
              <button type="button" onClick={() => startAction('discard', menu.path)}>
                <Undo2 size={14} />
                Discard working changes
              </button>
            )}
            <button
              type="button"
              className="danger"
              onClick={() => startAction('delete', menu.path)}
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </>
      )}
      {action && (
        <FileActionDialog
          action={action}
          value={value}
          setValue={setValue}
          busy={busy}
          error={error}
          onClose={() => {
            setAction(null);
            setError('');
          }}
          onConfirm={confirm}
          onDiscard={() => {
            if (action.kind === 'close') close(action.path, true);
            else if (action.kind === 'conflict')
              void run(async () => {
                if (!action.sha256)
                  throw new Error(
                    'The file was removed from disk. Copy your draft or reload before continuing.',
                  );
                const reviewed = action;
                await save(action.path, action.sha256);
                // A newer disk version replaces this review instead of closing it.
                setAction((current) => (current === reviewed ? null : current));
              });
          }}
          onSave={() =>
            void run(async () => {
              await save(action.path);
              if (docs.current[action.path]?.saved === docs.current[action.path]?.content)
                close(action.path, true);
            })
          }
          onReload={() =>
            void run(async () => {
              const result = await command('files.read', { filePath: action.path }, ['files.read']);
              const content = String(result['content'] ?? '');
              updateDocument(action.path, { content, saved: content });
              setAction(null);
            })
          }
        />
      )}
    </section>
  );
}

function HighlightLine({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:export|import|from|const|let|var|function|return|if|else|async|await|class|type|interface|true|false|null|undefined|new|throw|try|catch|public|private|def|fn|use|pub|impl|struct)\b|\b\d+(?:\.\d+)?\b)/g,
        )
        .map((token, index) => (
          <span
            key={index}
            className={
              token.startsWith('//')
                ? 'code-comment'
                : /^["'`]/.test(token)
                  ? 'code-string'
                  : /^\d/.test(token)
                    ? 'code-number'
                    : /^(export|import|from|const|let|var|function|return|if|else|async|await|class|type|interface|true|false|null|undefined|new|throw|try|catch|public|private|def|fn|use|pub|impl|struct)$/.test(
                          token,
                        )
                      ? 'code-keyword'
                      : undefined
            }
          >
            {token}
          </span>
        ))}
    </>
  );
}
function FileActionDialog({
  action,
  value,
  setValue,
  busy,
  error,
  onClose,
  onConfirm,
  onDiscard,
  onSave,
  onReload,
}: {
  action: Action;
  value: string;
  setValue: (value: string) => void;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onReload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const titles = {
    file: 'Create file',
    directory: 'Create folder',
    rename: 'Rename item',
    move: 'Move item',
    delete: 'Delete item',
    close: 'Unsaved changes',
    conflict: 'File changed on disk',
    discard: 'Discard working changes',
    commit: 'Commit staged changes',
    comment: 'Add review note',
  };
  const destructive = ['delete', 'discard'].includes(action.kind);
  return (
    <dialog
      ref={dialog}
      className="modal file-action-dialog"
      aria-label={titles[action.kind]}
      onCancel={onClose}
    >
      <header>
        <h2>{titles[action.kind]}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close file action"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <p className="file-action-path">
          {action.path}
          {action.line ? ` · line ${action.line}` : ''}
        </p>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        {destructive ? (
          <p>
            {action.kind === 'delete'
              ? 'This removes the item from disk, including its contents if it is a folder.'
              : 'This restores the working file from the Git index. Untracked files are removed.'}
          </p>
        ) : action.kind === 'close' ? (
          <p>Your edits have not been saved. Save the file or explicitly discard the draft.</p>
        ) : action.kind === 'conflict' ? (
          <p>
            Another process changed this file since you opened it. Your draft is still available.
            Reload the disk version or explicitly overwrite it. Overwrite replaces only the version
            on disk now; if it changes again, you will be asked again.
          </p>
        ) : (
          <label htmlFor="file-action-value">
            {action.kind === 'comment'
              ? 'Review note'
              : action.kind === 'commit'
                ? 'Commit message'
                : action.kind === 'move'
                  ? 'Destination folder'
                  : 'Project-relative path'}
            {action.kind === 'comment' || action.kind === 'commit' ? (
              <textarea
                id="file-action-value"
                aria-label={action.kind === 'comment' ? 'Review note' : 'Commit message'}
                rows={4}
                required
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <input
                id="file-action-value"
                aria-label={action.kind === 'move' ? 'Destination folder' : 'Project-relative path'}
                required={action.kind !== 'move'}
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
        )}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          {action.kind === 'close' ? (
            <>
              <button type="button" className="button secondary danger" onClick={onDiscard}>
                Discard draft
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={onSave}>
                Save and close
              </button>
            </>
          ) : action.kind === 'conflict' ? (
            <>
              <button type="button" className="button secondary" onClick={onReload}>
                Reload from disk
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={onDiscard}>
                Overwrite with my draft
              </button>
            </>
          ) : (
            <button
              type="submit"
              disabled={busy}
              className={`button ${destructive ? 'secondary danger' : 'primary'}`}
            >
              {busy ? 'Working…' : titles[action.kind]}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
