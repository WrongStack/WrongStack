import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Globe,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { markdownTarget } from './markdown-target';
import { openExternal } from './platform';
import { SkillDraftNotice, useSkillDraftBinding } from './SkillDraftNotice';
import {
  downloadSkillFile,
  skillInstructions,
  skillSource,
  skillSourceLink,
  skillUpdateSummary,
  skillWritable,
} from './skill-model';
import { surfaceI18n } from './surface-i18n';

export function SkillLibrary({
  command,
  scope,
  projectId,
  onOpenFile,
}: {
  command: EngineCommand;
  scope: 'project' | 'profile';
  /** Owner of durable edit drafts for project skills. */
  projectId?: string;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const sourceName = (value: unknown) =>
    t(`skillLib.source.${String(value)}`, { defaultValue: skillSource(value) });
  const [skills, setSkills] = useState<Record<string, unknown>[]>([]),
    [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [content, setContent] = useState<Record<string, unknown> | null>(null),
    [draft, setDraft] = useState(''),
    [editing, setEditing] = useState(false),
    [preview, setPreview] = useState(false);
  const [search, setSearch] = useState(''),
    [source, setSource] = useState('all'),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [enabled, setEnabled] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'create' | 'install' | 'uninstall' | 'leave' | null>(null),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [ref, setRef] = useState('');
  const draftSkill = useMemo(
    () =>
      selected &&
      content &&
      skillWritable(selected['source'], scope) &&
      (scope === 'profile' || projectId)
        ? { name: String(selected['name']), source: String(selected['source']) }
        : null,
    [selected, content, scope, projectId],
  );
  const drafts = useSkillDraftBinding({
    command,
    scope: scope === 'project' && projectId ? { kind: 'project', projectId } : { kind: 'profile' },
    skill: draftSkill,
    body: content ? String(content['body'] ?? '') : null,
    loaded: content,
    setDraft,
    setEditing,
  });
  const next = useRef<Record<string, unknown> | null>(null),
    generation = useRef(0);
  const load = useCallback(async () => {
    const result = await command('skills.list', {}, ['skills.list']);
    const loaded = entries(result['skills']);
    setSkills(loaded);
    setSelected((current) =>
      current
        ? (loaded.find(
            (skill) => skill['name'] === current['name'] && skill['source'] === current['source'],
          ) ?? current)
        : null,
    );
    setEnabled(result['enabled'] !== false);
    return loaded;
  }, [command]);
  useEffect(() => {
    setReading(true);
    void load()
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setReading(false));
  }, [load]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const read = async (skill: Record<string, unknown>) => {
    const id = ++generation.current;
    setSelected(skill);
    setContent(null);
    setEditing(false);
    setPreview(false);
    setReading(true);
    setError('');
    try {
      const result = await command(
        'skills.content',
        { name: skill['name'], source: skill['source'] },
        ['skills.content'],
        { timeoutMs: 30000 },
      );
      if (id === generation.current) {
        setContent(result);
        setDraft(String(result['body'] ?? ''));
      }
    } catch (e) {
      if (id === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === generation.current) setReading(false);
    }
  };
  const dirty = editing && draft !== content?.['body'];
  const choose = (skill: Record<string, unknown> | null) => {
    if (dirty) {
      next.current = skill;
      setDialog('leave');
      return;
    }
    if (skill) void read(skill);
    else {
      generation.current++;
      setSelected(null);
      setContent(null);
      setEditing(false);
      setReading(false);
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const before = await command(
        'skills.content',
        { name: selected?.['name'], source: selected?.['source'] },
        ['skills.content'],
      );
      if (before['body'] !== content?.['body']) throw new Error(t('skillLib.changedOnDisk'));
      // The engine re-checks the same text right before writing (engines without it ignore it).
      const edited = await command(
        'skills.edit',
        { name: selected?.['name'], body: draft, expectedBody: content?.['body'] },
        ['skills.edited'],
      );
      if (edited['success'] === false)
        throw new Error(String(edited['error'] ?? t('skillLib.notSaved')));
      const result = await command(
        'skills.content',
        { name: selected?.['name'], source: selected?.['source'] },
        ['skills.content'],
      );
      if (result['body'] !== draft) throw new Error(t('skillLib.differs'));
      // Clear parked edits before the new disk text arrives, so they are not offered as stale.
      await drafts.settle();
      setContent(result);
      setEditing(false);
      await load();
      setNotice(t('skillLib.saved'));
    });
  const confirm = () =>
    run(async () => {
      if (dialog === 'create') {
        const result = await command(
          'skills.create',
          {
            name: name.trim(),
            description: description.trim(),
            scope: scope === 'profile' ? 'global' : 'project',
          },
          ['skills.created'],
        );
        await load();
        await read({
          ...record(result['skill']),
          source: scope === 'profile' ? 'user' : 'project',
          description: description.trim(),
        });
        setEditing(true);
        setNotice(t('skillLib.created'));
      } else if (dialog === 'install') {
        const result = await command(
          'skills.install',
          { ref: ref.trim(), global: scope === 'profile' },
          ['skills.installed'],
          { timeoutMs: 180000 },
        );
        await load();
        const results = entries(result['results']);
        const failures = results.filter((item) => item['error']);
        if (failures.length)
          setError(
            failures
              .map((item) => `${item['name'] ?? t('skillLib.skillFallback')}: ${item['error']}`)
              .join('\n'),
          );
        setNotice(
          t(results.length === 1 ? 'skillLib.installResultsOne' : 'skillLib.installResultsMany', {
            n: results.length,
          }),
        );
      } else if (dialog === 'uninstall') {
        await command(
          'skills.uninstall',
          { name: selected?.['name'], global: scope === 'profile' },
          ['skills.uninstalled'],
        );
        setSelected(null);
        setContent(null);
        await load();
        setNotice(t('skillLib.uninstalled'));
      }
      setDialog(null);
    });
  const update = () =>
    run(async () => {
      const result = await command(
        'skills.update',
        { name: selected?.['name'], global: scope === 'profile' },
        ['skills.updated'],
        { timeoutMs: 180000 },
      );
      const failures = Array.isArray(result['errors']) ? result['errors'] : [];
      const loaded = await load();
      if (selected)
        await read(
          loaded.find(
            (skill) => skill['name'] === selected['name'] && skill['source'] === selected['source'],
          ) ?? selected,
        );
      if (failures.length)
        setError(
          failures
            .map((item) =>
              typeof item === 'string'
                ? item
                : `${record(item)['name'] ?? t('skillLib.skillFallback')}: ${record(item)['error'] ?? record(item)['message']}`,
            )
            .join('\n'),
        );
      setNotice(
        skillUpdateSummary(result, (updated, unchanged, failed) =>
          t('skillLib.updateSummary', { updated, unchanged, failed }),
        ),
      );
    });
  const exportAll = () =>
    run(async () => {
      const result = await command('skills.export', {}, ['skills.exported'], { timeoutMs: 45000 });
      if (typeof result['zipBase64'] !== 'string' || !result['zipBase64'])
        throw new Error(t('skillLib.noArchive'));
      const bytes = Uint8Array.from(atob(result['zipBase64']), (c) => c.charCodeAt(0));
      downloadSkillFile(bytes, 'wrongstack-skills.zip', 'application/zip');
      setNotice(t('skillLib.exported', { n: String(result['skillCount'] ?? 0) }));
    });
  const link = (url: string) => {
    const target = markdownTarget(url);
    if (target?.kind === 'external')
      void openExternal(target.value).catch((e) => setError(String(e)));
  };
  const visible = useMemo(
    () =>
      skills
        .filter(
          (skill) =>
            (source === 'all' || skill['source'] === source) &&
            `${skill['name']} ${skill['description']} ${skill['trigger']}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => String(a['name']).localeCompare(String(b['name']))),
    [skills, source, search],
  );
  const writable = skillWritable(selected?.['source'], scope),
    installed = writable && Boolean(selected?.['sourceUrl']);
  return (
    <section
      className={`skill-library skill-library-${scope}`}
      aria-label={scope === 'profile' ? t('skillLib.labelProfile') : t('skillLib.labelProject')}
    >
      <header className="studio-heading">
        <div>
          <span className="eyebrow">
            {scope === 'project' ? t('skillLib.eyebrowProject') : t('skillLib.eyebrowProfile')}
          </span>
          <h1>{t('skillLib.title')}</h1>
          <p>{t('skillLib.intro')}</p>
        </div>
        <div className="skill-library-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={busy || dirty || !enabled}
            onClick={() => void exportAll()}
          >
            <Download size={14} />
            {t('skillLib.export')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy || dirty || !enabled}
            onClick={() => {
              setRef('');
              setDialog('install');
            }}
          >
            <Globe size={14} />
            {t('skillLib.installGit')}
          </button>
          <button
            type="button"
            className="button primary small"
            disabled={busy || dirty || !enabled}
            onClick={() => {
              setName('');
              setDescription('');
              setDialog('create');
            }}
          >
            <Plus size={14} />
            {t('skillLib.new')}
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="session-error skill-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="studio-notice">
          <Check size={13} />
          {notice}
        </p>
      )}
      {!enabled ? (
        <div className="skill-empty">
          <ShieldCheck size={30} />
          <h2>{t('skillLib.disabledTitle')}</h2>
          <p>{t('skillLib.disabledHelp')}</p>
        </div>
      ) : (
        <>
          <div className="skill-library-summary">
            {[
              [t('skillLib.available'), skills.length],
              [t('skillLib.project'), skills.filter((s) => s['source'] === 'project').length],
              [t('skillLib.profile'), skills.filter((s) => s['source'] === 'user').length],
              [t('skillLib.bundled'), skills.filter((s) => s['source'] === 'bundled').length],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <strong>{String(value)}</strong>
                <span>{String(label)}</span>
              </div>
            ))}
            <small>
              {scope === 'project' ? t('skillLib.projectNote') : t('skillLib.profileNote')}
            </small>
          </div>
          <div className="skill-library-layout">
            <div className="skill-catalog">
              <div className="skill-library-search">
                <Search size={14} />
                <input
                  aria-label={t('skillLib.search')}
                  placeholder={t('skillLib.searchPlaceholder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label={t('skillLib.sourceFilter')}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="all">{t('skillLib.allSources')}</option>
                  {[...new Set(skills.map((s) => String(s['source'])))].sort().map((s) => (
                    <option key={s} value={s}>
                      {sourceName(s)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('skillLib.refresh')}
                  disabled={busy || dirty}
                  onClick={() => void run(load)}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              <div className="skill-catalog-list">
                {visible.map((skill) => (
                  <button
                    type="button"
                    key={`${skill['source']}:${skill['name']}`}
                    aria-label={t('skillLib.open', { name: String(skill['name']) })}
                    className={selected?.['name'] === skill['name'] ? 'selected-skill-card' : ''}
                    disabled={busy}
                    onClick={() => choose(skill)}
                  >
                    <BookOpen size={17} />
                    <div>
                      <strong>{String(skill['name'])}</strong>
                      <p>{String(skill['description'] ?? '')}</p>
                      <span>
                        {sourceName(skill['source'])}
                        {skill['version'] ? ` · v${skill['version']}` : ''}
                      </span>
                    </div>
                    <ArrowRight size={13} />
                  </button>
                ))}
              </div>
              {!visible.length && (
                <div className="skill-empty">
                  {reading ? <LoaderCircle size={25} className="spin" /> : <Sparkles size={25} />}
                  <h2>{reading ? t('skillLib.discovering') : t('skillLib.noMatch')}</h2>
                  <p>{t('skillLib.noMatchHelp')}</p>
                </div>
              )}
              <footer>
                {t('skillLib.count', { visible: visible.length, total: skills.length })}
              </footer>
            </div>
            <div className="skill-reader">
              {selected ? (
                <>
                  <header>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('skillLib.close')}
                      onClick={() => choose(null)}
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <span>{sourceName(selected['source'])}</span>
                    {writable && content && !editing && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={busy}
                        onClick={() => setEditing(true)}
                      >
                        <Pencil size={13} />
                        {t('skillLib.edit')}
                      </button>
                    )}
                    {content && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t('skillLib.download')}
                        onClick={() =>
                          downloadSkillFile(
                            String(content['body']),
                            `${selected['name']}-SKILL.md`,
                            'text/markdown',
                          )
                        }
                      >
                        <Download size={14} />
                      </button>
                    )}
                  </header>
                  <h2>{String(selected['name'])}</h2>
                  <p className="skill-reader-description">
                    {String(selected['description'] ?? '')}
                  </p>
                  {selected['trigger'] && (
                    <div className="skill-trigger">
                      <span>{t('skillLib.whenToUse')}</span>
                      <p>{String(selected['trigger'])}</p>
                    </div>
                  )}
                  <SkillDraftNotice
                    binding={drafts}
                    onUseSaved={(text) => {
                      setDraft(text);
                      setEditing(true);
                    }}
                  />
                  {reading ? (
                    <div className="skill-empty">
                      <LoaderCircle className="spin" size={25} />
                      <p>{t('skillLib.reading')}</p>
                    </div>
                  ) : (
                    content && (
                      <>
                        {editing ? (
                          <div className="skill-document-editor">
                            <header>
                              <span>
                                {t('skillLib.editorMeta', {
                                  lines: draft.split('\n').length,
                                  chars: draft.length,
                                })}
                              </span>
                              <button
                                type="button"
                                aria-pressed={preview}
                                onClick={() => setPreview(!preview)}
                              >
                                {preview ? t('skillLib.showSource') : t('skillLib.preview')}
                              </button>
                            </header>
                            {preview ? (
                              <MarkdownContent text={skillInstructions(draft)} onLink={link} />
                            ) : (
                              <textarea
                                aria-label={t('skillLib.sourceLabel')}
                                spellCheck={false}
                                value={draft}
                                disabled={busy}
                                onChange={(e) => {
                                  setDraft(e.target.value);
                                  drafts.edit(e.target.value);
                                }}
                                onKeyDown={(e) => {
                                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                                    e.preventDefault();
                                    if (dirty && !busy) void save();
                                  }
                                }}
                              />
                            )}
                            <footer>
                              <button
                                type="button"
                                className="button secondary small"
                                disabled={busy}
                                onClick={() => {
                                  if (dirty) {
                                    next.current = selected;
                                    setDialog('leave');
                                  } else setEditing(false);
                                }}
                              >
                                {t('skillLib.cancelEditing')}
                              </button>
                              <button
                                type="button"
                                className="button primary small"
                                disabled={busy || !dirty || !draft.trim()}
                                onClick={() => void save()}
                              >
                                <Save size={13} />
                                {busy ? t('skillLib.saving') : t('skillLib.save')}
                              </button>
                            </footer>
                          </div>
                        ) : (
                          <div className="skill-instructions">
                            <MarkdownContent
                              text={skillInstructions(String(content['body'] ?? ''))}
                              onLink={link}
                            />
                          </div>
                        )}
                        <div className="skill-evidence">
                          <section>
                            <h3>
                              <FolderOpen size={14} />
                              {t('skillLib.provenance')}
                            </h3>
                            <code>{String(content['path'] ?? '')}</code>
                            {typeof selected['sourceUrl'] === 'string' && selected['sourceUrl'] && (
                              <button
                                type="button"
                                onClick={() => link(skillSourceLink(selected['sourceUrl']))}
                              >
                                {String(selected['sourceUrl'])}
                                <ArrowRight size={12} />
                              </button>
                            )}
                            {typeof selected['ref'] === 'string' && selected['ref'] && (
                              <small>
                                {t('skillLib.revision', { ref: String(selected['ref']) })}
                              </small>
                            )}
                            {!writable && (
                              <p>
                                <ShieldCheck size={13} />
                                {t('skillLib.readOnly')}
                              </p>
                            )}
                          </section>
                          <section>
                            <h3>
                              <FileText size={14} />
                              {t('skillLib.related')}
                            </h3>
                            {Array.isArray(content['relatedFiles']) &&
                            content['relatedFiles'].length ? (
                              content['relatedFiles'].map((file: unknown) => (
                                <button
                                  type="button"
                                  key={String(file)}
                                  disabled={
                                    selected['source'] !== 'project' || !onOpenFile || busy || dirty
                                  }
                                  onClick={() => onOpenFile?.(String(file))}
                                >
                                  {String(file).split(/[/\\]/).at(-1)}
                                  <ArrowRight size={12} />
                                </button>
                              ))
                            ) : (
                              <p>{t('skillLib.noRelated')}</p>
                            )}
                          </section>
                          <section>
                            <h3>
                              <BookOpen size={14} />
                              {t('skillLib.referencedBy')}
                            </h3>
                            {Array.isArray(content['references']) &&
                            content['references'].length ? (
                              content['references'].map((name: unknown) => (
                                <button
                                  type="button"
                                  key={String(name)}
                                  disabled={busy}
                                  onClick={() => {
                                    const related = skills.find((skill) => skill['name'] === name);
                                    if (related) choose(related);
                                  }}
                                >
                                  {String(name)}
                                  <ArrowRight size={12} />
                                </button>
                              ))
                            ) : (
                              <p>{t('skillLib.noReferences')}</p>
                            )}
                          </section>
                        </div>
                        {installed && !editing && (
                          <footer className="skill-install-controls">
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => void update()}
                            >
                              <RefreshCw size={13} />
                              {t('skillLib.checkUpdates')}
                            </button>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => setDialog('uninstall')}
                            >
                              <Trash2 size={13} />
                              {t('skillLib.uninstall')}
                            </button>
                          </footer>
                        )}
                      </>
                    )
                  )}
                </>
              ) : (
                <div className="skill-reader-empty">
                  <BookOpen size={38} />
                  <h2>{t('skillLib.emptyTitle')}</h2>
                  <p>{t('skillLib.emptyHelp')}</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {dialog && (
        <div className="modal-backdrop">
          <section
            className="modal skill-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === 'create'
                ? t('skillLib.dialog.create')
                : dialog === 'install'
                  ? t('skillLib.dialog.install')
                  : dialog === 'leave'
                    ? t('skillLib.dialog.leave')
                    : t('skillLib.dialog.uninstall')
            }
          >
            <header>
              <h2>
                {dialog === 'create'
                  ? t('skillLib.heading.create')
                  : dialog === 'install'
                    ? t('skillLib.installGit')
                    : dialog === 'leave'
                      ? t('skillLib.heading.leave')
                      : t('skillLib.dialog.uninstall')}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t('skillLib.closeDialog')}
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <X size={17} />
              </button>
            </header>
            {error && (
              <p className="session-error" role="alert">
                {error}
              </p>
            )}
            {dialog === 'leave' ? (
              <>
                <p>{t('skillLib.leaveHelp')}</p>
                <footer>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(draft)
                        .then(() => setNotice(t('skillLib.draftCopied')))
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <Copy size={13} />
                    {t('skillLib.copyDraft')}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setDialog(null)}
                  >
                    {t('skillLib.keepEditing')}
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      const target = next.current;
                      drafts.discard();
                      setDialog(null);
                      if (target) void read(target);
                      else {
                        generation.current++;
                        setSelected(null);
                        setContent(null);
                        setEditing(false);
                      }
                    }}
                  >
                    {t('skillLib.discardDraft')}
                  </button>
                </footer>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirm();
                }}
              >
                {dialog === 'create' ? (
                  <>
                    <p>
                      {scope === 'profile'
                        ? t('skillLib.createProfile')
                        : t('skillLib.createProject')}
                    </p>
                    <label>
                      {t('skillLib.name')}
                      <input
                        aria-label={t('skillLib.nameLabel')}
                        placeholder="review-project-boundaries"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        required
                        maxLength={100}
                      />
                    </label>
                    <label>
                      {t('skillLib.description')}
                      <textarea
                        aria-label={t('skillLib.descriptionLabel')}
                        placeholder={t('skillLib.descriptionPlaceholder')}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        required
                        maxLength={1024}
                        rows={4}
                      />
                    </label>
                  </>
                ) : dialog === 'install' ? (
                  <>
                    <p>
                      {scope === 'profile'
                        ? t('skillLib.installProfile')
                        : t('skillLib.installProject')}
                    </p>
                    <label>
                      {t('skillLib.gitSource')}
                      <input
                        aria-label={t('skillLib.gitLabel')}
                        placeholder="owner/repository or https://github.com/owner/repository"
                        value={ref}
                        onChange={(e) => setRef(e.target.value)}
                        required
                      />
                    </label>
                  </>
                ) : (
                  <p>
                    <Trans
                      i18n={surfaceI18n}
                      ns="desktop"
                      i18nKey={
                        scope === 'profile'
                          ? 'skillLib.uninstallProfile'
                          : 'skillLib.uninstallProject'
                      }
                      values={{ name: String(selected?.['name']) }}
                      components={{ strong: <strong /> }}
                    />
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    {t('skillLib.cancel')}
                  </button>
                  <button type="submit" className="button primary" disabled={busy}>
                    {busy
                      ? t('skillLib.working')
                      : dialog === 'create'
                        ? t('skillLib.dialog.create')
                        : dialog === 'install'
                          ? t('skillLib.dialog.install')
                          : t('skillLib.dialog.uninstall')}
                  </button>
                </footer>
              </form>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
