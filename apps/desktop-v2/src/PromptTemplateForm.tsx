import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';

export function PromptTemplateForm({
  command,
  onDirty,
  onLocked,
  onCancel,
  onCreated,
}: {
  command: EngineCommand;
  onDirty: (dirty: boolean) => void;
  onLocked: (locked: boolean) => void;
  onCancel: () => void;
  onCreated: (slug: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [category, setCategory] = useState(''),
    [tags, setTags] = useState(''),
    [content, setContent] = useState(''),
    [required, setRequired] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false);
  const dirty = !!(title || description || category || tags || content);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onLocked(busy);
    return () => onLocked(false);
  }, [busy, onLocked]);
  const variables = [
    ...new Set([...content.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]!)),
  ];
  const save = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Enter a title and prompt instructions.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const slug =
        title
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64) || 'prompt';
      const fresh = await command('prompts.list', {}, ['prompts.list']);
      if (entries(fresh['prompts']).some((row) => row['slug'] === slug))
        throw Error(
          'A prompt with this identifier already exists. Choose a different title to avoid replacing it.',
        );
      const result = await command(
        'prompts.create',
        {
          title: title.trim(),
          description,
          content,
          category: category.trim() || 'uncategorized',
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          variables: variables.map((name) => ({ name, required: required.includes(name) })),
          // The engine re-checks right before writing; engines without it ignore the flag.
          ifAbsent: true,
        },
        ['prompts.created'],
      );
      if (result['success'] === false)
        throw Error(String(result['error'] ?? 'The prompt was not saved. Your draft is kept.'));
      const doc = await command('prompts.content', { slug: result['slug'] }, ['prompts.content']);
      if (doc['found'] !== true || doc['content'] !== content)
        throw Error('The saved template did not match readback. Your draft is kept.');
      onDirty(false);
      await onCreated(String(result['slug']));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prompt-authoring">
      <h3>Create a reusable prompt</h3>
      <p>
        Saved in your user prompt library. Use <code>{'{{name}}'}</code> for variables; existing
        prompts are checked before saving.
      </p>
      {error && (
        <p role="alert" className="composer-error">
          {error}
        </p>
      )}
      <label>
        Title
        <input
          aria-label="Template title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Description
        <input
          aria-label="Template description"
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="resource-form-row">
        <label>
          Category
          <input
            aria-label="Template category"
            value={category}
            disabled={busy}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label>
          Tags
          <input
            aria-label="Template tags"
            value={tags}
            disabled={busy}
            onChange={(e) => setTags(e.target.value)}
            placeholder="review, testing"
          />
        </label>
      </div>
      <label>
        Instructions
        <textarea
          aria-label="Template instructions"
          value={content}
          disabled={busy}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      {variables.length > 0 && (
        <fieldset className="template-required">
          <legend>Required variables</legend>
          {variables.map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={required.includes(name)}
                disabled={busy}
                onChange={(e) =>
                  setRequired(
                    e.target.checked
                      ? [...required, name]
                      : required.filter((value) => value !== name),
                  )
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
      )}
      {discard && (
        <div className="resource-leave">
          <p>Discard the unsaved template?</p>
          <button type="button" onClick={onCancel}>
            Discard new template
          </button>
          <button type="button" onClick={() => setDiscard(false)}>
            Keep editing
          </button>
        </div>
      )}
      <footer>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => (dirty ? setDiscard(true) : onCancel())}
        >
          Back to library
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save template'}
        </button>
      </footer>
    </div>
  );
}
