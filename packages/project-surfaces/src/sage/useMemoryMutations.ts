import { useCallback } from 'react';
import type { useAppTranslation } from '../lib/i18n';
import type { SageEntry } from './model-types';
import { normalizeAnchors, splitList } from './shared';

interface UseMemoryMutationsInput {
  draft: import('./shared.js').MemoryDraft;
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>;
  mutationGenerationRef: React.RefObject<number>;
  mutationCleanupRef: React.RefObject<(() => void) | null>;
  setBusyAction: React.Dispatch<React.SetStateAction<'create' | 'update' | 'delete' | null>>;
  setNotice: React.Dispatch<React.SetStateAction<string | null>>;
  mountedRef: React.RefObject<boolean>;
  setMemories: React.Dispatch<React.SetStateAction<import('./types.js').SageEntry[]>>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  t: ReturnType<typeof useAppTranslation>['t'];
  loadMemories: () => void;
  client: import('../host').SurfaceClient;
  rememberSage: (
    opts: {
      validity?:
        | {
            statement: string;
            checks?: { type: 'source_contains'; path: string; text: string }[] | undefined;
          }
        | undefined;
      text: string;
      kind?: string | undefined;
      scope?: import('./types.js').SageScope | undefined;
      tags?: string[] | undefined;
      importance?: number | undefined;
      confidence?: number | undefined;
      freshness?: number | undefined;
      anchors?: import('./types.js').SageAnchor[] | undefined;
      audience?:
        | {
            roles?: string[] | undefined;
            taskTypes?: string[] | undefined;
            modes?: string[] | undefined;
          }
        | undefined;
      supersedes?: string[] | undefined;
      contradicts?: string[] | undefined;
    },
    options?: import('../host').SurfaceSendOptions | undefined,
  ) => void;
  selectedMemory: import('./types.js').SageEntry | null;
  updateSage: (
    id: string,
    patch: Record<string, unknown>,
    options?: import('../host').SurfaceSendOptions | undefined,
  ) => void;
}

export function useMemoryMutations({
  draft,
  setMutationError,
  mutationGenerationRef,
  mutationCleanupRef,
  setBusyAction,
  setNotice,
  mountedRef,
  setMemories,
  setSelectedId,
  setCreating,
  setEditing,
  t,
  loadMemories,
  client,
  rememberSage,
  selectedMemory,
  updateSage,
}: UseMemoryMutationsInput) {
  const runMutation = useCallback(
    (
      type: 'memory.sage.remember' | 'memory.sage.update',
      send: () => void,
      action: 'create' | 'update',
    ) => {
      if (!draft.text.trim()) {
        setMutationError('Memory content is required.');
        return;
      }
      const generation = ++mutationGenerationRef.current;
      mutationCleanupRef.current?.();
      setBusyAction(action);
      setMutationError(null);
      setNotice(null);

      let off = () => {};
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        off();
        if (mutationCleanupRef.current === cleanup) mutationCleanupRef.current = null;
      };

      const onResponse = (message: {
        payload: { memory?: SageEntry | undefined; error?: string | undefined };
      }) => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) {
          cleanup();
          return;
        }
        cleanup();
        setBusyAction(null);
        if (message.payload.error || !message.payload.memory) {
          setMutationError(message.payload.error ?? 'The server returned no memory record.');
          return;
        }
        const saved = message.payload.memory;
        setMemories((current) => {
          const without = current.filter((memory) => memory.id !== saved.id);
          return [saved, ...without];
        });
        setSelectedId(saved.id);
        setCreating(false);
        setEditing(false);
        setNotice(
          action === 'create'
            ? t('activity:memoryManager.memoryCaptured')
            : t('activity:memoryManager.memoryUpdated'),
        );
        loadMemories();
      };

      if (type === 'memory.sage.remember') {
        off = client.on('memory.sage.remember', onResponse);
      } else {
        off = client.on('memory.sage.update', onResponse);
      }
      timeout = setTimeout(() => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) return;
        cleanup();
        setBusyAction(null);
        setMutationError(
          t('activity:memoryManager.mutationTimeout', {
            verb:
              action === 'create'
                ? t('activity:memoryManager.createAction')
                : t('common:action.save'),
          }),
        );
      }, 20_000);
      mutationCleanupRef.current = cleanup;
      send();
    },
    [client, draft.text, loadMemories, t],
  );

  const submitCreate = useCallback(() => {
    runMutation(
      'memory.sage.remember',
      () =>
        rememberSage(
          {
            text: draft.text.trim(),
            ...(draft.validityStatement?.trim()
              ? {
                  validity: {
                    statement: draft.validityStatement.trim(),
                    checks: draft.validityChecks ?? [],
                  },
                }
              : {}),
            kind: draft.kind,
            scope: draft.scope,
            tags: splitList(draft.tags),
            importance: draft.importance,
            confidence: draft.confidence,
            freshness: draft.freshness,
            anchors: normalizeAnchors(draft.anchors),
            ...(splitList(draft.audienceRoles).length ||
            splitList(draft.audienceTaskTypes).length ||
            splitList(draft.audienceModes).length
              ? {
                  audience: {
                    roles: splitList(draft.audienceRoles),
                    taskTypes: splitList(draft.audienceTaskTypes),
                    modes: splitList(draft.audienceModes),
                  },
                }
              : {}),
            supersedes: splitList(draft.supersedes),
            contradicts: splitList(draft.contradicts),
          },
          { echoToChat: false },
        ),
      'create',
    );
  }, [draft, rememberSage, runMutation]);

  const submitUpdate = useCallback(() => {
    if (!selectedMemory) return;
    runMutation(
      'memory.sage.update',
      () =>
        updateSage(
          selectedMemory.id,
          {
            expectedRevision: draft.observedRevision,
            validity: draft.validityStatement?.trim()
              ? { statement: draft.validityStatement.trim(), checks: draft.validityChecks ?? [] }
              : null,
            text: draft.text.trim(),
            kind: draft.kind,
            status: draft.status,
            tags: splitList(draft.tags),
            importance: draft.importance,
            confidence: draft.confidence,
            freshness: draft.freshness,
            anchors: normalizeAnchors(draft.anchors),
            ...(splitList(draft.audienceRoles).length ||
            splitList(draft.audienceTaskTypes).length ||
            splitList(draft.audienceModes).length
              ? {
                  audience: {
                    roles: splitList(draft.audienceRoles),
                    taskTypes: splitList(draft.audienceTaskTypes),
                    modes: splitList(draft.audienceModes),
                  },
                }
              : {}),
            supersedes: splitList(draft.supersedes),
            contradicts: splitList(draft.contradicts),
          },
          { echoToChat: false },
        ),
      'update',
    );
  }, [draft, runMutation, selectedMemory, updateSage]);
  return { submitCreate, submitUpdate };
}
