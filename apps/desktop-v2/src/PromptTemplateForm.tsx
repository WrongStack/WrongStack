import { useEffect, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { surfaceI18n } from './surface-i18n';

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
  const { t } = useDesktopText();
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
      setError(t('promptTemplate.enterTitle'));
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
        throw Error(t('promptTemplate.exists'));
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
        throw Error(String(result['error'] ?? t('promptTemplate.notSaved')));
      const doc = await command('prompts.content', { slug: result['slug'] }, ['prompts.content']);
      if (doc['found'] !== true || doc['content'] !== content)
        throw Error(t('promptTemplate.mismatch'));
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
      <h3>{t('promptTemplate.title')}</h3>
      <p>
        <Trans
          i18n={surfaceI18n}
          ns="desktop"
          i18nKey="promptTemplate.intro"
          values={{ token: '{{name}}' }}
          components={{ code: <code /> }}
        />
      </p>
      {error && (
        <p role="alert" className="composer-error">
          {error}
        </p>
      )}
      <label>
        {t('promptTemplate.titleField')}
        <input
          aria-label={t('promptTemplate.titleLabel')}
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        {t('promptTemplate.description')}
        <input
          aria-label={t('promptTemplate.descriptionLabel')}
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="resource-form-row">
        <label>
          {t('promptTemplate.category')}
          <input
            aria-label={t('promptTemplate.categoryLabel')}
            value={category}
            disabled={busy}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label>
          {t('promptTemplate.tags')}
          <input
            aria-label={t('promptTemplate.tagsLabel')}
            value={tags}
            disabled={busy}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('promptTemplate.tagsPlaceholder')}
          />
        </label>
      </div>
      <label>
        {t('promptTemplate.instructions')}
        <textarea
          aria-label={t('promptTemplate.instructionsLabel')}
          value={content}
          disabled={busy}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      {variables.length > 0 && (
        <fieldset className="template-required">
          <legend>{t('promptTemplate.requiredVariables')}</legend>
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
          <p>{t('promptTemplate.discardQuestion')}</p>
          <button type="button" onClick={onCancel}>
            {t('promptTemplate.discard')}
          </button>
          <button type="button" onClick={() => setDiscard(false)}>
            {t('promptTemplate.keepEditing')}
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
          {t('promptTemplate.back')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? t('promptTemplate.saving') : t('promptTemplate.save')}
        </button>
      </footer>
    </div>
  );
}
