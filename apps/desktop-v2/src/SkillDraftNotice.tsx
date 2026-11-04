import { useCallback, useEffect, useRef, useState } from 'react';
import { DiffPreview } from './DiffPreview';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { SkillEditorDraft } from './skill-editor-draft';
import { type SkillDraftScope, useDraftState, useSkillEditorDraft } from './useSkillEditorDraft';

/**
 * Connects the skill editor to its durable draft. Edits made against the current
 * disk text restore automatically; edits made against an older disk text are
 * shown beside the current version until the person chooses.
 */
export function useSkillDraftBinding({
  command,
  scope,
  skill,
  body,
  loaded,
  setDraft,
  setEditing,
}: {
  command: EngineCommand;
  scope: SkillDraftScope;
  skill: { name: string; source: string } | null;
  /** Skill text currently on disk, or null while it is unknown. */
  body: string | null;
  /** Changes on every read of the skill, so a re-read that resets the editor restores again. */
  loaded: unknown;
  setDraft: (text: string) => void;
  setEditing: (editing: boolean) => void;
}) {
  const { controller, unavailable } = useSkillEditorDraft(command, scope, skill);
  const state = useDraftState(controller);
  const [restored, setRestored] = useState(false);
  const [stale, setStale] = useState<SkillEditorDraft | null>(null);
  const owner = useRef(0);
  // `loaded` is a dependency on purpose: every fresh read of the skill restores again.
  useEffect(() => {
    const own = ++owner.current;
    setRestored(false);
    setStale(null);
    if (!controller || body === null) return;
    void controller.load().then(() => {
      if (own !== owner.current) return;
      const saved = controller.snapshot().value;
      if (!saved) return;
      if (saved.base === body) {
        setDraft(saved.body);
        setEditing(true);
        setRestored(true);
      } else setStale(saved);
    });
  }, [controller, body, loaded, setDraft, setEditing]);
  const edit = useCallback(
    (text: string) => {
      if (!controller || !state?.ready || stale || body === null) return;
      controller.edit(text === body ? null : { base: body, body: text });
    },
    [controller, state?.ready, stale, body],
  );
  return {
    controller,
    state,
    unavailable,
    restored,
    stale,
    body,
    edit,
    /** Continue older edits over the current disk text, which the person has now seen. */
    useStale: () => {
      if (!stale || !controller || body === null) return;
      setDraft(stale.body);
      setEditing(true);
      setStale(null);
      controller.edit({ base: body, body: stale.body });
    },
    discard: () => {
      setStale(null);
      setRestored(false);
      if (controller?.snapshot().ready) controller.edit(null);
    },
    /** Remove the parked edits after the skill file was saved and verified. */
    settle: async () => (controller ? controller.clear() : true),
  };
}

export function SkillDraftNotice({
  binding,
  onUseSaved,
}: {
  binding: ReturnType<typeof useSkillDraftBinding>;
  onUseSaved: (text: string) => void;
}) {
  const { t } = useDesktopText();
  const { state, stale, restored, unavailable, controller } = binding;
  return (
    <>
      {unavailable && unavailable !== 'pending' && (
        <p className="field-help" role="status">
          {t('skillLib.draft.unavailable', { reason: unavailable })}
        </p>
      )}
      {state?.error && (
        <p className="session-error" role="alert">
          {state.error}
        </p>
      )}
      {state?.review && controller && (
        <section className="skill-draft-notice" aria-label={t('skillLib.draft.conflictLabel')}>
          <p>{t('skillLib.draft.conflict')}</p>
          <p className="field-help">{t('skillLib.draft.conflictDiff')}</p>
          <DiffPreview
            before={state.review.value?.body ?? binding.body ?? ''}
            after={state.value?.body ?? binding.body ?? ''}
            path="SKILL.md"
          />
          <footer>
            <button
              type="button"
              className="button secondary small"
              onClick={() => void controller.resolve('local')}
            >
              {t('skillLib.draft.keepThis')}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                const saved = state.review?.value;
                void controller.resolve('saved').then((ok) => {
                  if (ok && saved && saved.base === binding.body) onUseSaved(saved.body);
                });
              }}
            >
              {t('skillLib.draft.useSaved')}
            </button>
          </footer>
        </section>
      )}
      {stale && (
        <section className="skill-draft-notice" aria-label={t('skillLib.draft.staleLabel')}>
          <p>{t('skillLib.draft.stale')}</p>
          <p className="field-help">{t('skillLib.draft.staleDiff')}</p>
          <DiffPreview before={binding.body ?? ''} after={stale.body} path="SKILL.md" />
          <footer>
            <button type="button" className="button secondary small" onClick={binding.useStale}>
              {t('skillLib.draft.continue')}
            </button>
            <button type="button" className="button secondary small" onClick={binding.discard}>
              {t('skillLib.draft.discard')}
            </button>
          </footer>
        </section>
      )}
      {restored && !stale && !state?.review && state?.value && (
        <p className="skill-draft-status" role="status">
          {t('skillLib.draft.restored')}
        </p>
      )}
    </>
  );
}
