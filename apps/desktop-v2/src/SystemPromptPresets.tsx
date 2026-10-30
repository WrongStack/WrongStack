import { useCallback, useEffect, useRef, useState } from 'react';
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
    <section className="prompt-presets" aria-label="Instruction presets">
      <h3>Instruction presets</h3>
      <p className="field-help">
        A preset replaces one built-in instruction variant with your edited copy. Choose it for this
        profile or only for this project; the project choice wins. Changes apply to new turns.
      </p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!catalog ? (
        <p role="status">Reading presets…</p>
      ) : (
        PROMPT_VARIANTS.map((variant) => {
          const current = effectivePreset(variant, catalog.active, catalog.projectActive);
          const options = presetsFor(variant);
          return (
            <fieldset key={variant} className="prompt-preset-variant">
              <legend>{variantNames[variant]}</legend>
              <p>
                In use here:{' '}
                {current.scope === 'built-in'
                  ? 'the built-in instructions'
                  : `${options.find((preset) => preset.id === current.id)?.name ?? current.id} (${current.scope})`}
              </p>
              {(['profile', 'project'] as const).map((scope) => {
                const selected =
                  (scope === 'project' ? catalog.projectActive : catalog.active)[variant] ?? '';
                return (
                  <label key={scope}>
                    {scope === 'profile' ? 'Profile choice' : 'This project'}
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
                          setNotice(`${variantNames[variant]} ${scope} choice saved.`);
                        })
                      }
                    >
                      <option value="">
                        {scope === 'profile' ? 'Built-in instructions' : 'Use the profile choice'}
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
                        {preset.sourceChanged && (
                          <em> · the built-in text changed since this was based on it</em>
                        )}
                      </span>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={busy || dirty}
                        onClick={() => open(preset)}
                      >
                        Edit
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
                                setNotice(`Deleted ${preset.name}.`);
                              })
                            }
                          >
                            Confirm delete
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => setDeleting('')}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          onClick={() => setDeleting(preset.id)}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          );
        })
      )}
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
          New preset name
          <input
            value={newName}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <label>
          Based on
          <select
            value={newVariant}
            disabled={busy}
            onChange={(event) => setNewVariant(event.target.value as PromptVariant)}
          >
            {PROMPT_VARIANTS.map((variant) => (
              <option key={variant} value={variant}>
                {variantNames[variant]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="button secondary small"
          disabled={busy || !newName.trim() || dirty}
        >
          Create from built-in
        </button>
      </form>
      {editing && (
        <form
          className="prompt-preset-editor"
          aria-label={`Edit preset ${editing.name}`}
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
              setNotice('Preset saved.');
            });
          }}
        >
          <label>
            Name
            <input
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Instructions ({variantNames[editing.baseVariant]} base, revision {editing.revision})
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
              <p>
                The built-in {variantNames[editing.baseVariant]} instructions changed since this
                preset was based on them. Compare, then mark them reviewed to record the current
                built-in text as the new base. Your text is not changed.
              </p>
              <details>
                <summary>Current built-in text</summary>
                <pre>{editing.currentBaseText}</pre>
              </details>
              <label>
                <input
                  type="checkbox"
                  checked={reviewedSource}
                  onChange={(event) => setReviewedSource(event.target.checked)}
                />
                I reviewed the updated built-in text
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
              Check
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
              Preview for this session
            </button>
            <button
              type="submit"
              className="button primary small"
              disabled={busy || (!dirty && !reviewedSource)}
            >
              Save preset
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {dirty ? 'Discard changes' : 'Close'}
            </button>
          </div>
          {issues && (
            <ul className="prompt-preset-issues" aria-label="Preset check">
              {issues.length === 0 ? (
                <li>No problems found.</li>
              ) : (
                issues.map((issue) => (
                  <li
                    key={`${issue.line}:${issue.message}`}
                    className={issue.severity === 'error' ? 'session-error' : ''}
                  >
                    Line {issue.line}: {issue.message}
                  </li>
                ))
              )}
            </ul>
          )}
          {preview && (
            <details open>
              <summary>Rendered for this session's tools and tier</summary>
              <pre>{preview}</pre>
            </details>
          )}
        </form>
      )}
    </section>
  );
}
