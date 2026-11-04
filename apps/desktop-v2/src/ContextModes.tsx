import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  type ContextMode,
  contextModes,
  type ModeDraft,
  modeDraft,
  modePayload,
} from './context-modes-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';

/**
 * The conversation's context mode: switch between the engine's modes, and create, edit or
 * delete project custom modes. Built-in modes are read-only in the engine and here.
 */
export function ContextModes({
  command,
  onChanged,
}: {
  command: EngineCommand;
  onChanged: () => void;
}) {
  const { t } = useDesktopText();
  const [modes, setModes] = useState<ContextMode[] | null>(null),
    [draft, setDraft] = useState<{ value: ModeDraft; editing: boolean } | null>(null),
    [confirmDelete, setConfirmDelete] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try {
      setModes(contextModes(await command('context.modes.list', {}, ['context.modes.list'])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [command]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (type: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const reply = await command(type, payload, ['key.operation_result']);
      setNotice(String(reply['message'] ?? t('contextModes.done')));
      setDraft(null);
      setConfirmDelete('');
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!draft) return;
    let payload: ReturnType<typeof modePayload>;
    try {
      payload = modePayload(draft.value, {
        id: t('contextModes.error.id'),
        name: t('contextModes.error.name'),
        percent: (label) => t('contextModes.error.percent', { label }),
        rising: t('contextModes.error.rising'),
        count: (label) => t('contextModes.error.count', { label }),
        warn: t('contextModes.error.warn'),
        soft: t('contextModes.error.soft'),
        hard: t('contextModes.error.hard'),
        preserveK: t('contextModes.error.preserveK'),
        elise: t('contextModes.error.elise'),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    void act(draft.editing ? 'context.mode.update' : 'context.mode.create', payload);
  };
  const field = (key: keyof ModeDraft, extra: { suffix?: string } = {}) =>
    draft && (
      <label className="context-mode-field">
        {t(`contextModes.field.${key}`)}
        <input
          value={draft.value[key]}
          disabled={busy || (key === 'id' && draft.editing)}
          onChange={(event) =>
            setDraft({ ...draft, value: { ...draft.value, [key]: event.target.value } })
          }
        />
        {extra.suffix && <small>{extra.suffix}</small>}
      </label>
    );
  return (
    <section className="context-modes" aria-label={t('contextModes.label')}>
      <header>
        <h3>{t('contextModes.label')}</h3>
        <button
          type="button"
          className="button secondary small"
          disabled={busy || !!draft}
          onClick={() => setDraft({ value: modeDraft(), editing: false })}
        >
          <Plus size={13} /> {t('contextModes.new')}
        </button>
      </header>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="composer-notice">
          {notice}
        </p>
      )}
      {!modes ? (
        <p role="status">{t('contextModes.reading')}</p>
      ) : (
        <ul>
          {modes.map((mode) => (
            <li key={mode.id} className={mode.active ? 'active' : ''}>
              <div>
                <strong>{mode.name}</strong>
                <small>
                  {t('contextModes.facts', {
                    id: mode.id,
                    warn: Math.round(mode.thresholds.warn * 100),
                    soft: Math.round(mode.thresholds.soft * 100),
                    hard: Math.round(mode.thresholds.hard * 100),
                    keep: mode.preserveK,
                  })}
                  {mode.custom ? t('contextModes.custom') : ''}
                </small>
                {mode.description && <small>{mode.description}</small>}
              </div>
              {mode.active ? (
                <span>{t('contextModes.inUse')}</span>
              ) : (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => void act('context.mode.switch', { id: mode.id })}
                >
                  {t('contextModes.use')}
                </button>
              )}
              {mode.custom && (
                <>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || !!draft}
                    onClick={() => setDraft({ value: modeDraft(mode), editing: true })}
                  >
                    {t('contextModes.edit')}
                  </button>
                  {confirmDelete === mode.id ? (
                    <button
                      type="button"
                      className="button danger small"
                      disabled={busy}
                      onClick={() => void act('context.mode.delete', { id: mode.id })}
                    >
                      {t('contextModes.confirmDelete')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy}
                      title={t('contextModes.deleteTitle')}
                      onClick={() => setConfirmDelete(mode.id)}
                    >
                      {t('contextModes.delete')}
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <form
          className="context-mode-form"
          aria-label={draft.editing ? t('contextModes.editForm') : t('contextModes.newForm')}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {field('id')}
          {field('name')}
          {field('description')}
          {field('warn')}
          {field('soft')}
          {field('hard')}
          {field('preserveK')}
          {field('eliseThreshold')}
          <div>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t('contextModes.cancel')}
            </button>
            <button type="submit" className="button primary small" disabled={busy}>
              {draft.editing ? t('contextModes.save') : t('contextModes.create')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
