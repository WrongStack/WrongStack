import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import {
  effectivePreset,
  PROMPT_VARIANTS,
  type PromptPreset,
  type PromptPresetIssue,
  type PromptVariant,
  promptIssues,
  promptPresets,
  variantNames,
} from './system-prompt-presets-model';
import './system-prompt-presets.css';

type Catalog = ReturnType<typeof promptPresets>;

/**
 * Instruction presets: edited copies of a built-in system prompt variant, kept in the profile
 * and selected per variant for the profile or this project (a project selection wins).
 * Saves are revision-checked; when the built-in text changed since a preset was based on it,
 * saving can take the updated built-in text as the new base after review.
 */
export function SystemPromptPresets({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const variantWord = (variant: PromptVariant) =>
    t(`systemPrompts.variant.${variant}`, { defaultValue: variantNames[variant] });
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [editing, setEditing] = useState<PromptPreset | null>(null),
    [name, setName] = useState(''),
    [text, setText] = useState(''),
    [reviewedSource, setReviewedSource] = useState(false),
    [issues, setIssues] = useState<PromptPresetIssue[] | null>(null),
    [preview, setPreview] = useState(''),
    [newName, setNewName] = useState(''),
    [newVariant, setNewVariant] = useState<PromptVariant>('default'),
    [deleting, setDeleting] = useState('');
  const previewRequest = useRef(0);
  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);
  const act = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      const next = promptPresets(
        await command(`system_prompt.presets.${action}`, payload, ['system_prompt.presets']),
      );
      setCatalog(next);
      return next;
    },
    [command],
  );
  useEffect(() => {
    void run(async () => {
      await act('get');
    });
  }, [act, run]);
  const open = (preset: PromptPreset) => {
    setEditing(preset);
    setName(preset.name);
    setText(preset.text);
    setReviewedSource(false);
    setIssues(null);
    setPreview('');
  };
  const dirty = editing !== null && (name !== editing.name || text !== editing.text);
  const presetsFor = (variant: PromptVariant) =>
    catalog?.presets.filter((preset) => preset.baseVariant === variant) ?? [];
  return (
    <section className="prompt-presets" aria-label={t('systemPrompts.title')}>
      <h3>{t('systemPrompts.title')}</h3>
      <p className="field-help">{t('systemPrompts.intro')}</p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!catalog
        ? // Only while the read is in flight; a failed read leaves the error above, not a spinner
          // line that never ends.
          busy && <p role="status">{t('systemPrompts.reading')}</p>
        : PROMPT_VARIANTS.map((variant) => {
            const current = effectivePreset(variant, catalog.active, catalog.projectActive);
            const options = presetsFor(variant);
            return (
              <fieldset key={variant} className="prompt-preset-variant">
                <legend>{variantWord(variant)}</legend>
                <p>
                  {current.scope === 'built-in'
                    ? t('systemPrompts.inUseBuiltIn')
                    : t('systemPrompts.inUse', {
                        name:
                          options.find((preset) => preset.id === current.id)?.name ?? current.id,
                        scope: t(`systemPrompts.scope.${current.scope}`),
                      })}
                </p>
                {(['profile', 'project'] as const).map((scope) => {
                  const selected =
                    (scope === 'project' ? catalog.projectActive : catalog.active)[variant] ?? '';
                  return (
                    <label key={scope}>
                      {scope === 'profile'
                        ? t('systemPrompts.profileChoice')
                        : t('systemPrompts.projectChoice')}
                      <select
                        value={selected}
                        disabled={busy}
                        onChange={(event) =>
                          void run(async () => {
                            await act('activate', {
                              baseVariant: variant,
                              scope,
                              ...(event.target.value ? { id: event.target.value } : {}),
                            });
                            setNotice(
                              t('systemPrompts.choiceSaved', {
                                variant: variantWord(variant),
                                scope: t(`systemPrompts.scope.${scope}`),
                              }),
                            );
                          })
                        }
                      >
                        <option value="">
                          {scope === 'profile'
                            ? t('systemPrompts.builtIn')
                            : t('systemPrompts.useProfile')}
                        </option>
                        {options.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
                {options.length > 0 && (
                  <ul>
                    {options.map((preset) => (
                      <li key={preset.id}>
                        <span>
                          {preset.name}
                          {preset.sourceChanged && <em>{t('systemPrompts.sourceChanged')}</em>}
                        </span>
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy || dirty}
                          onClick={() => open(preset)}
                        >
                          {t('systemPrompts.edit')}
                        </button>
                        {deleting === preset.id ? (
                          <>
                            <button
                              type="button"
                              className="button danger small"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await act('delete', { id: preset.id });
                                  setDeleting('');
                                  if (editing?.id === preset.id) setEditing(null);
                                  setNotice(t('systemPrompts.deleted', { name: preset.name }));
                                })
                              }
                            >
                              {t('systemPrompts.confirmDelete')}
                            </button>
                            <button
                              type="button"
                              className="button secondary small"
                              onClick={() => setDeleting('')}
                            >
                              {t('systemPrompts.keep')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button secondary small"
                            disabled={busy}
                            onClick={() => setDeleting(preset.id)}
                          >
                            {t('systemPrompts.delete')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
            );
          })}
      <form
        className="prompt-preset-new"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const next = await act('create', { name: newName.trim(), baseVariant: newVariant });
            const created = next.presets.find((preset) => preset.id === next.selectedId);
            setNewName('');
            if (created) open(created);
          });
        }}
      >
        <label>
          {t('systemPrompts.newName')}
          <input
            value={newName}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <label>
          {t('systemPrompts.basedOn')}
          <select
            value={newVariant}
            disabled={busy}
            onChange={(event) => setNewVariant(event.target.value as PromptVariant)}
          >
            {PROMPT_VARIANTS.map((variant) => (
              <option key={variant} value={variant}>
                {variantWord(variant)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="button secondary small"
          disabled={busy || !newName.trim() || dirty}
        >
          {t('systemPrompts.create')}
        </button>
      </form>
      {editing && (
        <form
          className="prompt-preset-editor"
          aria-label={t('systemPrompts.editLabel', { name: editing.name })}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const next = await act('save', {
                id: editing.id,
                revision: editing.revision,
                name: name.trim(),
                text,
                reviewedCurrentSource: reviewedSource,
              });
              const saved = next.presets.find((preset) => preset.id === editing.id);
              if (saved) open(saved);
              setNotice(t('systemPrompts.saved'));
            });
          }}
        >
          <label>
            {t('systemPrompts.name')}
            <input
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('systemPrompts.instructions', {
              variant: variantWord(editing.baseVariant),
              revision: editing.revision,
            })}
            <textarea
              value={text}
              rows={16}
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value);
                setIssues(null);
              }}
            />
          </label>
          {editing.sourceChanged && (
            <div className="prompt-preset-source">
              <p>{t('systemPrompts.sourceBody', { variant: variantWord(editing.baseVariant) })}</p>
              <details>
                <summary>{t('systemPrompts.currentText')}</summary>
                <pre>{editing.currentBaseText}</pre>
              </details>
              <label>
                <input
                  type="checkbox"
                  checked={reviewedSource}
                  onChange={(event) => setReviewedSource(event.target.checked)}
                />
                {t('systemPrompts.reviewed')}
              </label>
            </div>
          )}
          <div className="prompt-preset-actions">
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setIssues(
                    promptIssues(
                      await command('system_prompt.presets.validate', { text }, [
                        'system_prompt.preset_validation',
                      ]),
                    ),
                  );
                })
              }
            >
              {t('systemPrompts.check')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const id = ++previewRequest.current;
                  const reply = await command(
                    'system_prompt.presets.preview',
                    { text, requestId: String(id) },
                    ['system_prompt.preset_preview'],
                  );
                  if (id !== previewRequest.current) return;
                  setIssues(promptIssues(reply));
                  setPreview(typeof reply['rendered'] === 'string' ? reply['rendered'] : '');
                })
              }
            >
              {t('systemPrompts.previewSession')}
            </button>
            <button
              type="submit"
              className="button primary small"
              disabled={busy || (!dirty && !reviewedSource)}
            >
              {t('systemPrompts.save')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {dirty ? t('systemPrompts.discardChanges') : t('systemPrompts.close')}
            </button>
          </div>
          {issues && (
            <ul className="prompt-preset-issues" aria-label={t('systemPrompts.issues')}>
              {issues.length === 0 ? (
                <li>{t('systemPrompts.noProblems')}</li>
              ) : (
                issues.map((issue) => (
                  <li
                    key={`${issue.line}:${issue.message}`}
                    className={issue.severity === 'error' ? 'session-error' : ''}
                  >
                    {t('systemPrompts.line', { line: issue.line, message: issue.message })}
                  </li>
                ))
              )}
            </ul>
          )}
          {preview && (
            <details open>
              <summary>{t('systemPrompts.rendered')}</summary>
              <pre>{preview}</pre>
            </details>
          )}
        </form>
      )}
    </section>
  );
}
