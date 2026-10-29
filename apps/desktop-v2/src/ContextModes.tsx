import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  type ContextMode,
  contextModes,
  type ModeDraft,
  modeDraft,
  modePayload,
} from './context-modes-model';
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
      setNotice(String(reply['message'] ?? 'Done.'));
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
      payload = modePayload(draft.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    void act(draft.editing ? 'context.mode.update' : 'context.mode.create', payload);
  };
  const field = (key: keyof ModeDraft, label: string, extra: { suffix?: string } = {}) =>
    draft && (
      <label className="context-mode-field">
        {label}
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
    <section className="context-modes" aria-label="Context modes">
      <header>
        <h3>Context modes</h3>
        <button
          type="button"
          className="button secondary small"
          disabled={busy || !!draft}
          onClick={() => setDraft({ value: modeDraft(), editing: false })}
        >
          <Plus size={13} /> New mode
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
        <p role="status">Reading context modes…</p>
      ) : (
        <ul>
          {modes.map((mode) => (
            <li key={mode.id} className={mode.active ? 'active' : ''}>
              <div>
                <strong>{mode.name}</strong>
                <small>
                  {mode.id} · warn {Math.round(mode.thresholds.warn * 100)}% · compact{' '}
                  {Math.round(mode.thresholds.soft * 100)}% · hard{' '}
                  {Math.round(mode.thresholds.hard * 100)}% · keeps {mode.preserveK} recent turns
                  {mode.custom ? ' · custom' : ''}
                </small>
                {mode.description && <small>{mode.description}</small>}
              </div>
              {mode.active ? (
                <span>In use</span>
              ) : (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => void act('context.mode.switch', { id: mode.id })}
                >
                  Use
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
                    Edit
                  </button>
                  {confirmDelete === mode.id ? (
                    <button
                      type="button"
                      className="button danger small"
                      disabled={busy}
                      onClick={() => void act('context.mode.delete', { id: mode.id })}
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy}
                      title="Conversations using it return to the default mode"
                      onClick={() => setConfirmDelete(mode.id)}
                    >
                      Delete
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
          aria-label={draft.editing ? 'Edit context mode' : 'New context mode'}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {field('id', 'Mode ID')}
          {field('name', 'Name')}
          {field('description', 'Description')}
          {field('warn', 'Warn at (% of window)')}
          {field('soft', 'Compact at (% of window)')}
          {field('hard', 'Hard limit (% of window)')}
          {field('preserveK', 'Recent turns kept')}
          {field('eliseThreshold', 'Elide older tool results above (tokens)')}
          <div>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button type="submit" className="button primary small" disabled={busy}>
              {draft.editing ? 'Save mode' : 'Create mode'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
