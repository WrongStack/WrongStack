import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ComposerAttachment, validateAttachments } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  type ComposerFileReference,
  validReferenceLines,
  validSnippet,
} from './composer-resources-model';
import { DraftWriter } from './draft-storage';
import type { InputDraft } from './input-form-model';
import { initialSnapshot, isLive, type Session, type Snapshot, visibleSessions } from './model';
import { getSnapshot, layoutKey, native, request } from './platform';
import { nextSessionAfterDetach, restoreSessionTabs } from './session-layout';
import { useAppearance } from './useAppearance';

type Section = 'fleet' | 'projects' | 'activity' | 'engine' | 'project' | 'wrongstack';
type DraftRevisions = Record<'text' | 'references' | 'attachments' | 'mode', number>;
interface SavedDraft {
  text: string;
  references: ComposerFileReference[];
  attachments: ComposerAttachment[];
  mode: SubmitMode;
  revisions: DraftRevisions;
}
function validateSavedDraft(value: SavedDraft): SavedDraft {
  if (typeof value.text !== 'string') throw Error('Saved draft text is invalid.');
  if (
    !Array.isArray(value.references) ||
    value.references.some(
      (ref) =>
        !ref ||
        typeof ref.path !== 'string' ||
        !ref.path ||
        (ref.lines !== undefined && !validReferenceLines(ref.lines)) ||
        (ref.snippet !== undefined && !validSnippet(ref.snippet)),
    )
  )
    throw Error('Saved file references are invalid.');
  if (
    !Array.isArray(value.attachments) ||
    value.attachments.some(
      (item) =>
        !item ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.data !== 'string' ||
        typeof item.mediaType !== 'string' ||
        typeof item.bytes !== 'number',
    )
  )
    throw Error('Saved attachments are invalid.');
  validateAttachments(value.attachments);
  if (!['btw', 'queue', 'steer'].includes(value.mode))
    throw Error('Saved delivery mode is invalid.');
  if (
    !value.revisions ||
    ['text', 'references', 'attachments', 'mode'].some(
      (key) =>
        !Number.isSafeInteger(value.revisions[key as keyof DraftRevisions]) ||
        value.revisions[key as keyof DraftRevisions] < 0,
    )
  )
    throw Error('Saved draft revisions are invalid.');
  return value;
}
export type ProjectPage =
  | 'overview'
  | 'memory'
  | 'kanban'
  | 'goals'
  | 'sdd'
  | 'atlas'
  | 'automations'
  | 'chronicle'
  | 'mailbox'
  | 'worktrees'
  | 'kit'
  | 'techstack'
  | 'deadcode'
  | 'design'
  | 'reviews'
  | 'history'
  | 'roster'
  | 'live-fleet'
  | 'skills'
  | 'files'
  | 'changes';
export function useDesktop() {
  useEffect(() => {
    // File drops belong to explicit workspaces; never navigate the shell away
    // from the application when a user misses the composer.
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [project, setProject] = useState<string | null>(
    new URLSearchParams(location.search).get('project'),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftModes, setDraftModes] = useState<Record<string, SubmitMode>>({});
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [draftConflicts, setDraftConflicts] = useState<Record<string, boolean>>({});
  const draftConflictRef = useRef<Record<string, boolean>>({});
  const [draftReviews, setDraftReviews] = useState<Record<string, SavedDraft>>({});
  const [draftReviewErrors, setDraftReviewErrors] = useState<Record<string, string>>({});
  const [draftReviewLoading, setDraftReviewLoading] = useState<Record<string, boolean>>({});
  const [draftRecovering, setDraftRecovering] = useState<Record<string, boolean>>({});
  const [draftRetry, setDraftRetry] = useState(0);
  const draftWriter = useMemo(
    () =>
      new DraftWriter((id, text, expectedRevision) =>
        request<{ revision: number }>('draft.save', { id, text, expectedRevision }).then(
          (result) => result.revision,
        ),
      ),
    [],
  );
  const referenceWriter = useMemo(
    () =>
      new DraftWriter((id, text, expectedRevision) =>
        request<{ revision: number }>('draft.save', {
          id,
          part: 'references',
          text,
          expectedRevision,
        }).then((result) => result.revision),
      ),
    [],
  );
  const attachmentWriter = useMemo(
    () =>
      new DraftWriter((id, text, expectedRevision) =>
        request<{ revision: number }>('draft.save', {
          id,
          part: 'attachments',
          text,
          expectedRevision,
        }).then((result) => result.revision),
      ),
    [],
  );
  const modeWriter = useMemo(
    () =>
      new DraftWriter((id, text, expectedRevision) =>
        request<{ revision: number }>('draft.save', {
          id,
          part: 'mode',
          text,
          expectedRevision,
        }).then((result) => result.revision),
      ),
    [],
  );
  const [composerAttachments, setComposerAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [composerReferences, setComposerReferences] = useState<
    Record<string, ComposerFileReference[]>
  >({});
  const [inputDrafts, setInputDrafts] = useState<Record<string, InputDraft>>({});
  const setInputDraft = useCallback(
    (id: string, draft: InputDraft | null) =>
      setInputDrafts((current) => {
        if (draft) return { ...current, [id]: draft };
        if (!Object.hasOwn(current, id)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }),
    [],
  );
  const [section, setSection] = useState<Section>(
    new URLSearchParams(location.search).has('project') ? 'project' : 'fleet',
  );
  const [projectPage, setProjectPage] = useState<ProjectPage>('overview');
  const [settingsReturnSession, setSettingsReturnSession] = useState<string | null>(null);
  const openProjectPage = (id: string, page: ProjectPage = 'overview') => {
    setProject(id);
    setProjectPage(page);
    setSection('project');
    setSelected(null);
  };
  const openWrongStackSettings = (sessionId?: string) => {
    setSettingsReturnSession(sessionId ?? null);
    setSection('wrongstack');
  };
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [restored, setRestored] = useState(false);
  const [dialog, setDialog] = useState<'session' | 'palette' | 'preview' | null>(null);
  const [pending, setPending] = useState(false);
  const [sessionProject, setSessionProject] = useState('');
  const [kind, setKind] = useState<'agent' | 'terminal'>('agent');
  const [title, setTitle] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [preview, setPreview] = useState('http://localhost:3000');
  const restoredRef = useRef(false);
  const reportError = useCallback(
    (e: unknown) => setError(String(e instanceof Error ? e.message : e)),
    [],
  );
  const reportDraftFailure = useCallback(
    (id: string, error: unknown, message: string) => {
      if (String(error).includes('DRAFT_CONFLICT')) {
        draftConflictRef.current[id] = true;
        setDraftConflicts((current) => ({ ...current, [id]: true }));
      } else reportError(new Error(message));
    },
    [reportError],
  );
  const setAttachments = useCallback(
    (id: string, items: ComposerAttachment[]) => {
      setComposerAttachments((current) => ({ ...current, [id]: items }));
      if (draftConflictRef.current[id]) return Promise.resolve(false);
      return native
        ? attachmentWriter.write(id, JSON.stringify(items)).then(
            () => true,
            (error) => {
              reportDraftFailure(id, error, 'Could not save draft attachments for restart.');
              return false;
            },
          )
        : Promise.resolve(true);
    },
    [attachmentWriter, reportDraftFailure],
  );
  const setComposerRefs = useCallback(
    (id: string, refs: ComposerFileReference[]) => {
      setComposerReferences((current) => ({ ...current, [id]: refs }));
      if (draftConflictRef.current[id]) return Promise.resolve(false);
      return native
        ? referenceWriter.write(id, JSON.stringify(refs)).then(
            () => true,
            (error) => {
              reportDraftFailure(id, error, 'Could not save draft file references for restart.');
              return false;
            },
          )
        : Promise.resolve(true);
    },
    [referenceWriter, reportDraftFailure],
  );
  const appearance = useAppearance(snapshot.appearance, reportError);
  const setDraftMode = useCallback(
    (id: string, mode: SubmitMode) => {
      setDraftModes((current) => ({ ...current, [id]: mode }));
      if (draftConflictRef.current[id]) return;
      if (native)
        void modeWriter
          .write(id, mode)
          .catch((error) =>
            reportDraftFailure(id, error, 'Could not save delivery mode for restart.'),
          );
    },
    [modeWriter, reportDraftFailure],
  );
  const refresh = useCallback(async () => {
    try {
      const next = await getSnapshot();
      setSnapshot(next);
      setConnected(true);
      if (!restoredRef.current) {
        restoredRef.current = true;
        try {
          const layout: unknown = next.layout ? JSON.parse(next.layout) : null;
          if (layout && typeof layout === 'object') {
            const saved = layout as Record<string, unknown>;
            if (
              !location.search &&
              ['fleet', 'projects', 'activity', 'engine', 'project', 'wrongstack'].includes(
                String(saved['section']),
              )
            )
              setSection(saved['section'] as Section);
            if (
              [
                'overview',
                'memory',
                'kanban',
                'goals',
                'sdd',
                'atlas',
                'automations',
                'chronicle',
                'mailbox',
                'worktrees',
                'kit',
                'techstack',
                'deadcode',
                'design',
                'reviews',
                'history',
                'roster',
                'live-fleet',
                'skills',
                'files',
                'changes',
              ].includes(String(saved['projectPage']))
            )
              setProjectPage(saved['projectPage'] as ProjectPage);
            setOpenSessionIds(restoreSessionTabs(saved, next.sessions));
            if (
              !location.search &&
              typeof saved['project'] === 'string' &&
              next.projects.some((p) => p.id === saved['project'])
            )
              setProject(saved['project']);
            if (
              !location.search &&
              typeof saved['selected'] === 'string' &&
              next.sessions.some((s) => s.id === saved['selected'])
            )
              setSelected(saved['selected']);
          }
        } catch {
          /* Invalid saved UI layout never prevents registry recovery. */
        }
        setRestored(true);
      }
    } catch (e) {
      setConnected(false);
      reportError(e);
    }
  }, [reportError]);
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!restored || !native) return;
    const timer = setTimeout(() => {
      void request('settings.save', {
        key: layoutKey,
        value: JSON.stringify({ project, selected, openSessionIds, section, projectPage }),
      }).catch(reportError);
    }, 400);
    return () => clearTimeout(timer);
  }, [project, selected, openSessionIds, section, projectPage, restored, reportError]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDialog((d) => (d === 'palette' ? null : 'palette'));
      }
      if (event.key === 'Escape') {
        setDialog(null);
        setSearch('');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setPending(false);
    }
  };
  const newSession = (preferred?: string, sessionKind: 'agent' | 'terminal' = 'agent') => {
    setSessionProject(preferred ?? project ?? snapshot.projects[0]?.id ?? '');
    setKind(sessionKind);
    setTitle('');
    setWorkdir('');
    setDialog('session');
  };
  const currentProject = snapshot.projects.find((p) => p.id === project);
  const active = snapshot.sessions.filter(isLive);
  const attention = snapshot.sessions.filter(
    (s) => s.status === 'error' || s.status === 'interrupted',
  );
  const sessions = useMemo(
    () => visibleSessions(snapshot, project, search, filter),
    [snapshot, project, search, filter],
  );
  const currentSession = snapshot.sessions.find((s) => s.id === selected);
  const sessionKind = currentSession?.kind;
  useEffect(() => {
    if (!selected || sessionKind !== 'agent' || Object.hasOwn(drafts, selected)) return;
    let active = true;
    void request<SavedDraft>('draft.get', { id: selected })
      .then((saved) => {
        if (!active) return;
        const { text, references, attachments, mode, revisions } = validateSavedDraft(saved);
        draftWriter.initialize(selected, revisions?.text);
        referenceWriter.initialize(selected, revisions?.references);
        attachmentWriter.initialize(selected, revisions?.attachments);
        modeWriter.initialize(selected, revisions?.mode);
        setComposerReferences((current) => ({ ...current, [selected]: references }));
        setComposerAttachments((current) => ({ ...current, [selected]: attachments }));
        setDraftModes((current) => ({ ...current, [selected]: mode }));
        setDrafts((current) => ({ ...current, [selected]: text }));
        setDraftErrors((current) => ({ ...current, [selected]: '' }));
        draftConflictRef.current[selected] = false;
        setDraftConflicts((current) => ({ ...current, [selected]: false }));
        setDraftRecovering((current) => ({ ...current, [selected]: false }));
      })
      .catch((error: unknown) => {
        if (active)
          setDraftErrors((current) => ({
            ...current,
            [selected]: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => {
      active = false;
    };
  }, [
    selected,
    sessionKind,
    draftRetry,
    drafts,
    draftWriter,
    referenceWriter,
    attachmentWriter,
    modeWriter,
  ]);
  const jumpToSession = (s: Session) => {
    setOpenSessionIds((ids) => (ids.includes(s.id) ? ids : [...ids, s.id]));
    setSelected(s.id);
    setProject(s.projectId);
    setSection('fleet');
    setDialog(null);
  };
  const closeSessionTab = (id: string) => {
    const next = nextSessionAfterDetach(openSessionIds, selected, id);
    setOpenSessionIds((ids) => ids.filter((candidate) => candidate !== id));
    setSelected(next);
    const session = snapshot.sessions.find((s) => s.id === next);
    if (session) setProject(session.projectId);
  };
  const getDraft = (id: string) => drafts[id] ?? '';
  const setDraft = (id: string, text: string) => {
    setDrafts((current) => ({ ...current, [id]: text }));
    if (draftConflictRef.current[id]) return Promise.resolve(false);
    return native
      ? draftWriter.write(id, text).then(
          () => true,
          (error) => {
            reportDraftFailure(
              id,
              error,
              'Could not save this draft for restart. Keep the application open or copy your text.',
            );
            return false;
          },
        )
      : Promise.resolve(true);
  };
  const projectRequestLock = useRef(false);
  const prepareProjectRequest = async (projectId: string, id: string, text: string) => {
    const target = snapshot.sessions.find(
      (item) => item.id === id && item.projectId === projectId && item.kind === 'agent',
    );
    if (!target || projectRequestLock.current)
      throw Error('Choose an available conversation in this project.');
    projectRequestLock.current = true;
    try {
      let current = drafts[id];
      if (current === undefined) {
        const saved = validateSavedDraft(await request<SavedDraft>('draft.get', { id }));
        current = saved.text;
        draftWriter.initialize(id, saved.revisions.text);
        referenceWriter.initialize(id, saved.revisions.references);
        attachmentWriter.initialize(id, saved.revisions.attachments);
        modeWriter.initialize(id, saved.revisions.mode);
        setComposerReferences((all) => ({ ...all, [id]: saved.references }));
        setComposerAttachments((all) => ({ ...all, [id]: saved.attachments }));
        setDraftModes((all) => ({ ...all, [id]: saved.mode }));
      }
      const saved = await setDraft(id, current.trim() ? `${current}\n\n${text}` : text);
      // Never send automatically. The user reviews the appended instruction in chat.
      jumpToSession(target);
      return saved;
    } finally {
      projectRequestLock.current = false;
    }
  };
  const prepareDraftReview = async (id: string) => {
    setDraftReviewLoading((current) => ({ ...current, [id]: true }));
    setDraftReviewErrors((current) => ({ ...current, [id]: '' }));
    try {
      await Promise.all([
        draftWriter.drain(id),
        referenceWriter.drain(id),
        attachmentWriter.drain(id),
        modeWriter.drain(id),
      ]);
      const saved = validateSavedDraft(await request<SavedDraft>('draft.get', { id }));
      setDraftReviews((current) => ({ ...current, [id]: saved }));
    } catch (error) {
      setDraftReviewErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setDraftReviewLoading((current) => ({ ...current, [id]: false }));
    }
  };
  const resolveDraftConflict = async (id: string, choice: 'local' | 'saved') => {
    const reviewed = draftReviews[id];
    if (!reviewed) return;
    const local = {
      text: drafts[id] ?? '',
      references: composerReferences[id] ?? [],
      attachments: composerAttachments[id] ?? [],
      mode: draftModes[id] ?? 'btw',
    };
    setDraftRecovering((current) => ({ ...current, [id]: true }));
    setDraftReviewErrors((current) => ({ ...current, [id]: '' }));
    try {
      await Promise.all([
        draftWriter.drain(id),
        referenceWriter.drain(id),
        attachmentWriter.drain(id),
        modeWriter.drain(id),
      ]);
      let next: SavedDraft;
      if (choice === 'saved') {
        next = validateSavedDraft(await request<SavedDraft>('draft.get', { id }));
        if (
          Object.keys(reviewed.revisions).some(
            (key) =>
              reviewed.revisions[key as keyof DraftRevisions] !==
              next.revisions[key as keyof DraftRevisions],
          )
        )
          throw Error('DRAFT_CONFLICT: The saved draft changed again. Review the latest version.');
      } else {
        validateAttachments(local.attachments);
        const revisions = await request<DraftRevisions>('draft.replace', {
          id,
          draft: local,
          expectedRevisions: reviewed.revisions,
        });
        next = validateSavedDraft({ ...local, revisions });
      }
      draftWriter.initialize(id, next.revisions.text);
      referenceWriter.initialize(id, next.revisions.references);
      attachmentWriter.initialize(id, next.revisions.attachments);
      modeWriter.initialize(id, next.revisions.mode);
      setDrafts((current) => ({ ...current, [id]: next.text }));
      setComposerReferences((current) => ({ ...current, [id]: next.references }));
      setComposerAttachments((current) => ({ ...current, [id]: next.attachments }));
      setDraftModes((current) => ({ ...current, [id]: next.mode }));
      draftConflictRef.current[id] = false;
      setDraftConflicts((current) => ({ ...current, [id]: false }));
      setDraftReviews((current) => {
        const updated = { ...current };
        delete updated[id];
        return updated;
      });
    } catch (error) {
      setDraftReviewErrors((current) => ({
        ...current,
        [id]: String(error).includes('DRAFT_CONFLICT')
          ? 'The saved draft changed again. Review the latest version before choosing.'
          : error instanceof Error
            ? error.message
            : String(error),
      }));
    } finally {
      setDraftRecovering((current) => ({ ...current, [id]: false }));
    }
  };
  const validateDraft = async (id: string): Promise<boolean> => {
    if (!native) return true;
    await Promise.all([
      draftWriter.drain(id),
      referenceWriter.drain(id),
      attachmentWriter.drain(id),
      modeWriter.drain(id),
    ]);
    const saved = await request<Record<'text' | 'references' | 'attachments' | 'mode', number>>(
      'draft.revisions',
      { id },
    );
    const matches =
      saved.text === draftWriter.revision(id) &&
      saved.references === referenceWriter.revision(id) &&
      saved.attachments === attachmentWriter.revision(id) &&
      saved.mode === modeWriter.revision(id);
    if (!matches) setDraftConflicts((current) => ({ ...current, [id]: true }));
    if (!matches) draftConflictRef.current[id] = true;
    return matches;
  };
  const showFleet = () => {
    setSelected(null);
    setProject(null);
    setSection('fleet');
  };
  const createSession = () =>
    run(async () => {
      const opened = await request<Session>('session.open', {
        projectId: sessionProject,
        kind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(workdir.trim() ? { workdir: workdir.trim() } : {}),
      });
      jumpToSession(opened);
    });

  return {
    projectPage,
    setProjectPage,
    openProjectPage,
    openWrongStackSettings,
    settingsReturnSession,
    setSettingsReturnSession,
    ...appearance,
    snapshot,
    project,
    setProject,
    selected,
    openSessionIds,
    closeSessionTab,
    showFleet,
    drafts,
    draftModes,
    setDraftMode,
    getDraft,
    draftErrors,
    draftConflicts,
    draftRecovering,
    draftReviews,
    draftReviewErrors,
    draftReviewLoading,
    prepareDraftReview,
    resolveDraftConflict,
    validateDraft,
    retryDraft: () => setDraftRetry((value) => value + 1),
    composerReferences,
    composerAttachments,
    setAttachments,
    setComposerRefs,
    setDraft,
    prepareProjectRequest,
    inputDrafts,
    setInputDraft,
    setSelected,
    section,
    setSection,
    filter,
    setFilter,
    search,
    setSearch,
    error,
    setError,
    connected,
    dialog,
    setDialog,
    pending,
    sessionProject,
    setSessionProject,
    kind,
    setKind,
    title,
    setTitle,
    workdir,
    setWorkdir,
    preview,
    setPreview,
    reportError,
    run,
    newSession,
    currentProject,
    active,
    attention,
    sessions,
    currentSession,
    jumpToSession,
    createSession,
  };
}
export type DesktopController = ReturnType<typeof useDesktop>;
