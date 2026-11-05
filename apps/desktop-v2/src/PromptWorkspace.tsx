import { BookOpen, Clock3, LoaderCircle, Plus, RefreshCw, Search, Star, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import { type PromptVariable, renderPromptTemplate } from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { PromptJournal } from './PromptJournal';
import { PromptTemplateForm } from './PromptTemplateForm';
import { RuntimeGate } from './RuntimeGate';
import { useProjectEngine } from './useEngine';
import './composer-dialog.css';
import './composer-resources.css';

export function PromptWorkspace({
  projectId,
  sessionId,
  kind,
  onInsert,
  onClose,
}: {
  projectId: string;
  sessionId: string;
  kind: 'library' | 'journal';
  onInsert?: ((text: string) => void) | undefined;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const [dirty, setDirty] = useState(false),
    [locked, setLocked] = useState(false),
    [leave, setLeave] = useState(false);
  const close = () => {
    if (locked) return;
    if (dirty) setLeave(true);
    else onClose();
  };
  return (
    <Modal onClose={close}>
      <div className="composer-dialog resource-dialog">
        <header>
          <div>
            <span className="eyebrow">{t('promptWorkspace.eyebrow')}</span>
            <h2 id="dialog-title">
              {kind === 'library' ? <BookOpen size={20} /> : <Clock3 size={20} />}
              {kind === 'library' ? t('promptWorkspace.library') : t('promptWorkspace.journal')}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('promptWorkspace.close')}
            disabled={locked}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        {leave && (
          <div className="resource-leave">
            <p>{t('promptWorkspace.unsaved')}</p>
            <button type="button" className="button secondary" onClick={() => setLeave(false)}>
              {t('promptWorkspace.keepEditing')}
            </button>
            <button type="button" className="button primary" onClick={onClose}>
              {t('promptWorkspace.discard')}
            </button>
          </div>
        )}
        <div hidden={leave}>
          <RuntimeGate scope="project" projectId={projectId}>
            <ProjectPrompts
              projectId={projectId}
              sessionId={sessionId}
              kind={kind}
              onInsert={onInsert}
              onDirty={setDirty}
              onLocked={setLocked}
            />
          </RuntimeGate>
        </div>
      </div>
    </Modal>
  );
}
function ProjectPrompts({
  projectId,
  sessionId,
  kind,
  onInsert,
  onDirty,
  onLocked,
}: {
  projectId: string;
  sessionId: string;
  kind: 'library' | 'journal';
  onInsert?: ((text: string) => void) | undefined;
  onDirty: (dirty: boolean) => void;
  onLocked: (locked: boolean) => void;
}) {
  const { t } = useDesktopText();
  const [connectionError, setConnectionError] = useState('');
  const report = useCallback(
    (e: unknown) => setConnectionError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const { state, command } = useProjectEngine(projectId, report);
  if (!state.connected)
    return (
      <p className="resource-loading" role="status">
        <LoaderCircle size={15} className="spin" /> {t('promptWorkspace.connecting')}{' '}
        {connectionError}
      </p>
    );
  return kind === 'journal' ? (
    <PromptJournal command={command} sessionId={sessionId} onInsert={onInsert} />
  ) : (
    <PromptLibrary command={command} onInsert={onInsert} onDirty={onDirty} onLocked={onLocked} />
  );
}
function PromptLibrary({
  command,
  onInsert,
  onDirty,
  onLocked,
}: {
  command: EngineCommand;
  onInsert?: ((text: string) => void) | undefined;
  onDirty: (dirty: boolean) => void;
  onLocked: (locked: boolean) => void;
}) {
  const { t } = useDesktopText();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]),
    [content, setContent] = useState<Record<string, unknown> | null>(null),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [filter, setFilter] = useState('all'),
    [recent, setRecent] = useState<string[]>([]),
    [level, setLevel] = useState('detailed'),
    [values, setValues] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [enabled, setEnabled] = useState(true),
    [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalog, usage] = await Promise.all([
        command('prompts.list', {}, ['prompts.list']),
        command('prompts.recent', {}, ['prompts.recent']),
      ]);
      const loaded = entries(catalog['prompts']);
      setRows(loaded);
      setEnabled(catalog['enabled'] !== false);
      setRecent(
        Array.isArray(usage['slugs'])
          ? usage['slugs'].filter((slug): slug is string => typeof slug === 'string')
          : [],
      );
      return loaded;
    } finally {
      setLoading(false);
    }
  }, [command]);
  useEffect(() => {
    void load().catch((e) => setError(String(e instanceof Error ? e.message : e)));
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    onLocked(busy);
    return () => onLocked(false);
  }, [busy, onLocked]);
  const select = async (slug: string) => {
    const own = ++generation.current;
    setReading(true);
    setContent(null);
    setError('');
    try {
      const doc = await command('prompts.content', { slug }, ['prompts.content']);
      if (own !== generation.current) return;
      if (doc['found'] !== true) throw Error(t('promptLibrary.missing'));
      setContent(doc);
      const available = Object.entries(record(doc['variants'])).filter(
        (entry) => typeof entry[1] === 'string',
      );
      setLevel(
        available.some(([name]) => name === 'detailed')
          ? 'detailed'
          : (available[0]?.[0] ?? 'detailed'),
      );
      setValues(
        Object.fromEntries(
          entries(doc['variables']).map((v) => [String(v['name']), String(v['default'] ?? '')]),
        ),
      );
    } catch (e) {
      if (own === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === generation.current) setReading(false);
    }
  };
  const favorite = async () => {
    if (!content) return;
    setBusy(true);
    setError('');
    try {
      const item = rows.find((row) => row['slug'] === content['slug']);
      await command(
        'prompts.favorite',
        { slug: content['slug'], favorite: item?.['favorite'] !== true },
        ['prompts.favorite'],
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const variants = Object.entries(record(content?.['variants'])).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  const sourceText =
    variants.find(([name]) => name === level)?.[1] ?? String(content?.['content'] ?? '');
  const variables = entries(content?.['variables']) as unknown as PromptVariable[];
  const missing = variables.filter(
    (variable) => variable.required && !values[variable.name]?.trim(),
  );
  const rendered = renderPromptTemplate(sourceText, values);
  const visible = rows.filter(
    (row) =>
      (!category || row['category'] === category) &&
      (filter !== 'favorites' || row['favorite'] === true) &&
      (filter !== 'recent' || recent.includes(String(row['slug']))) &&
      `${row['title']} ${row['description']} ${row['slug']} ${String(row['tags'])}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  if (filter === 'recent')
    visible.sort((a, b) => recent.indexOf(String(a['slug'])) - recent.indexOf(String(b['slug'])));
  if (creating)
    return (
      <PromptTemplateForm
        command={command}
        onDirty={onDirty}
        onLocked={onLocked}
        onCancel={() => setCreating(false)}
        onCreated={async (slug) => {
          setCreating(false);
          await load();
          await select(slug);
        }}
      />
    );
  return (
    <>
      <p>{t('promptLibrary.intro')}</p>
      <div className="resource-toolbar">
        <label>
          <Search size={14} />
          <input
            aria-label={t('promptLibrary.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('promptLibrary.placeholder')}
          />
        </label>
        <select
          aria-label={t('promptLibrary.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('promptLibrary.allCategories')}</option>
          {[...new Set(rows.map((row) => String(row['category'] ?? 'uncategorized')))]
            .sort()
            .map((name) => (
              <option key={name}>{name}</option>
            ))}
        </select>
        <select
          aria-label={t('promptLibrary.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">{t('promptLibrary.all')}</option>
          <option value="favorites">{t('promptLibrary.favorites')}</option>
          <option value="recent">{t('promptLibrary.recent')}</option>
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label={t('promptLibrary.refresh')}
          disabled={loading || busy}
          onClick={() => void load().catch((e) => setError(String(e)))}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!enabled || loading || busy}
          onClick={() => setCreating(true)}
        >
          <Plus size={14} /> {t('promptLibrary.newTemplate')}
        </button>
      </div>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {!enabled ? (
        <p className="resource-empty">{t('promptLibrary.disabled')}</p>
      ) : (
        <div className="prompt-library-layout">
          <section className="resource-list" aria-label={t('promptLibrary.templates')}>
            {loading ? (
              <p role="status">{t('promptLibrary.loading')}</p>
            ) : visible.length ? (
              visible.map((row) => (
                <button
                  type="button"
                  key={String(row['slug'])}
                  aria-pressed={content?.['slug'] === row['slug']}
                  onClick={() => void select(String(row['slug']))}
                >
                  <strong>
                    {row['favorite'] === true && <Star size={11} />} {String(row['title'])}
                  </strong>
                  <span>{String(row['description'] ?? '')}</span>
                  <small>
                    {String(row['category'])} · {String(row['source'])}
                  </small>
                </button>
              ))
            ) : (
              <p className="resource-empty">{t('promptLibrary.noMatch')}</p>
            )}
          </section>
          <section className="resource-detail" aria-label={t('promptLibrary.details')}>
            {reading ? (
              <p role="status">{t('promptLibrary.reading')}</p>
            ) : content ? (
              <>
                <header>
                  <div>
                    <h3>{String(content['title'])}</h3>
                    <small>
                      {String(content['source'])} · {String(content['category'])}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="composer-chip"
                    disabled={busy}
                    onClick={() => void favorite()}
                  >
                    <Star size={13} />{' '}
                    {rows.find((row) => row['slug'] === content['slug'])?.['favorite'] === true
                      ? t('promptLibrary.unfavorite')
                      : t('promptLibrary.favorite')}
                  </button>
                </header>
                {variants.length > 0 && (
                  <label>
                    {t('promptLibrary.level')}
                    <select
                      aria-label={t('promptLibrary.levelLabel')}
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                    >
                      {variants.map(([name]) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {variables.length > 0 && (
                  <fieldset className="prompt-variables">
                    <legend>{t('promptLibrary.variables')}</legend>
                    {variables.map((variable) => (
                      <label key={variable.name} htmlFor={`prompt-var-${variable.name}`}>
                        {variable.name}
                        {variable.required ? ' *' : ''}
                        {variable.description && <small>{variable.description}</small>}
                        {variable.enum?.length ? (
                          <select
                            id={`prompt-var-${variable.name}`}
                            aria-label={t('promptLibrary.variable', { name: variable.name })}
                            value={values[variable.name] ?? ''}
                            onChange={(e) =>
                              setValues({ ...values, [variable.name]: e.target.value })
                            }
                          >
                            <option value="">{t('promptLibrary.choose')}</option>
                            {variable.enum.map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        ) : variable.multiline ? (
                          <textarea
                            id={`prompt-var-${variable.name}`}
                            aria-label={t('promptLibrary.variable', { name: variable.name })}
                            value={values[variable.name] ?? ''}
                            onChange={(e) =>
                              setValues({ ...values, [variable.name]: e.target.value })
                            }
                          />
                        ) : (
                          <input
                            id={`prompt-var-${variable.name}`}
                            aria-label={t('promptLibrary.variable', { name: variable.name })}
                            value={values[variable.name] ?? ''}
                            onChange={(e) =>
                              setValues({ ...values, [variable.name]: e.target.value })
                            }
                          />
                        )}
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="prompt-template-preview">
                  <MarkdownContent text={rendered} />
                </div>
                {missing.length > 0 && (
                  <p className="field-help">
                    {t('promptLibrary.required', { names: missing.map((v) => v.name).join(', ') })}
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!onInsert || missing.length > 0 || busy || !rendered.trim()}
                    onClick={() => {
                      void command('prompts.used', { slug: content['slug'] }, [
                        'prompts.used',
                      ]).catch(() => {});
                      onInsert?.(rendered);
                    }}
                  >
                    {t('promptLibrary.insert')}
                  </button>
                  <CopyButton text={rendered} label={t('promptLibrary.copy')} />
                  {!onInsert && <small>{t('promptLibrary.openChat')}</small>}
                </footer>
              </>
            ) : (
              <div className="resource-empty">
                <BookOpen size={26} />
                <h3>{t('promptLibrary.emptyTitle')}</h3>
                <p>{t('promptLibrary.emptyBody')}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
