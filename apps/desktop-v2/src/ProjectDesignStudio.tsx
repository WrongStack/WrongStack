import { Check, FileCode2, Palette, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DesignEditDraftNotice, useDesignEditDraft } from './DesignEditDraftNotice';
import { DesignExtractForm } from './DesignExtractForm';
import { DesignThemePreview } from './DesignThemePreview';
import { materializeProjectTheme } from './design-studio-actions';
import {
  designColorValue,
  designOverrideConflict,
  designOverrideExpectation,
  designTheme,
  designTokens,
  designValuesMatch,
} from './design-studio-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import type { Session } from './model';
import './project-design-studio.css';
import { displayDecimal } from './display-dates';

export function ProjectDesignStudio({
  projectId,
  command,
  onOpenFile,
  sessions = [],
  onPrepare,
  onNewSession,
}: {
  projectId: string;
  command: EngineCommand;
  onOpenFile: (path: string) => void;
  sessions?: readonly Session[] | undefined;
  onPrepare?: ((id: string, text: string) => Promise<boolean>) | undefined;
  onNewSession?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [catalog, setCatalog] = useState<Record<string, unknown>>({});
  const [extractOpen, setExtractOpen] = useState(false);
  const [conversation, setConversation] = useState('');
  const agents = sessions.filter((item) => item.projectId === projectId && item.kind === 'agent');
  const target = agents.find((item) => item.id === conversation);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [stack, setStack] = useState('web');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [body, setBody] = useState<{ kit: string; text: string } | null>(null);
  const [colorTheme, setColorTheme] = useState<'light' | 'dark'>('light');
  const [colors, setColors] = useState<Record<string, string>>({});
  const [colorBaseline, setColorBaseline] = useState<Record<string, string> | null>(null);
  const [tune, setTune] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<'use' | 'swap' | 'write' | null>(null);
  const [outPath, setOutPath] = useState('');
  const [written, setWritten] = useState('');
  const [verification, setVerification] = useState<Record<string, unknown> | null>(null);
  const [contrast, setContrast] = useState<Record<string, unknown>[] | null>(null);
  const generation = useRef(0),
    locked = useRef(false);
  const adopt = useCallback((data: Record<string, unknown>) => {
    setCatalog(data);
    const kits = entries(data['kits']);
    setSelected((id) =>
      kits.some((kit) => kit['id'] === id)
        ? id
        : String(data['activeKit'] ?? kits[0]?.['id'] ?? ''),
    );
    if (typeof data['stack'] === 'string') setStack(data['stack']);
  }, []);
  const load = useCallback(async () => {
    const own = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const data = await command('design.list', {}, ['design.list']);
      if (own === generation.current) {
        adopt(data);
        setContrast(null);
        setVerification(null);
      }
    } catch (e) {
      if (own === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === generation.current) setLoading(false);
    }
  }, [command, adopt]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const kits = entries(catalog['kits']);
  const kit = kits.find((item) => item['id'] === selected);
  const supportedStacks = Array.isArray(kit?.['stacks']) ? kit['stacks'].map(String) : [];
  useEffect(() => {
    if (
      kit &&
      Array.isArray(kit['stacks']) &&
      kit['stacks'].length &&
      !kit['stacks'].includes(stack)
    )
      setStack(String(kit['stacks'][0]));
  }, [kit, stack]);
  const activeId = typeof catalog['activeKit'] === 'string' ? catalog['activeKit'] : '';
  const edits = useMemo(
    () => ({ colors, baseline: colorBaseline, tune }),
    [colors, colorBaseline, tune],
  );
  const editDraft = useDesignEditDraft(projectId, activeId, edits, (restored) => {
    setColors(restored.colors);
    setColorBaseline(restored.baseline);
    setTune(restored.tune);
  });
  const overrides = designTokens(catalog['overrides']);
  const isActive = selected === activeId;
  const dirty = Object.keys(colors).length > 0;
  const tuneDirty = Object.values(tune).some((value) => value.trim());
  const shownOverrides = isActive ? { ...overrides, ...colors } : {};
  const validColors = Object.values(colors).every(designColorValue);
  const filtered = kits.filter((item) => {
    const axesObj =
      item['axes'] && typeof item['axes'] === 'object'
        ? (item['axes'] as Record<string, unknown>)
        : undefined;
    const axesText = axesObj
      ? `${axesObj['paper'] ?? ''}/${axesObj['display'] ?? ''}/${axesObj['accent'] ?? ''}`
      : '';
    return `${item['name']} ${item['id']} ${item['aesthetic']} ${item['material'] ?? ''} ${item['posture'] ?? ''} ${axesText} ${Array.isArray(item['tags']) ? item['tags'].join(' ') : ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    const own = generation.current;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (e) {
      if (own === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      locked.current = false;
      if (own === generation.current) setBusy(false);
    }
  };
  const currentActive = async () => {
    const fresh = await command('design.list', {}, ['design.list']);
    if (fresh['activeKit'] !== activeId) throw Error(t('designStudio.activeChangedEdit'));
    return fresh;
  };
  const pin = async (type: 'design.use' | 'design.swap') => {
    if (!kit || dirty || tuneDirty) return;
    setConfirmation(null);
    await run(async () => {
      // The engine pins only if the project still has the kit this gallery shows.
      const response = await command(
        type,
        { kit: selected, stack, expectedKit: activeId || null },
        [type],
      );
      if (response['ok'] === false)
        throw Error(
          response['conflict'] === true
            ? t('designStudio.activeChangedChange')
            : String(response['error'] ?? t('designStudio.kitRefused')),
        );
      const saved = await command('design.list', {}, ['design.list']);
      if (saved['activeKit'] !== selected || saved['stack'] !== stack)
        throw Error(t('designStudio.kitReadback'));
      adopt(saved);
      setBody({ kit: selected, text: String(response['body'] ?? '') });
      setContrast(
        Array.isArray(response['contrastIssues']) ? entries(response['contrastIssues']) : null,
      );
      setVerification(null);
      setWritten('');
      setTune({});
      setNotice(
        type === 'design.swap' ? t('designStudio.kitReplaced') : t('designStudio.kitSaved'),
      );
    });
  };
  const saveColors = async () => {
    if (!dirty || !validColors) return;
    await run(async () => {
      const current = await currentActive();
      if (
        designOverrideConflict(
          colorBaseline ?? overrides,
          designTokens(current['overrides']),
          colors,
        )
      )
        throw Error(t('designStudio.colorConflict'));
      // The engine re-checks the kit and these values under its file lock before writing.
      const response = await command(
        'design.set',
        {
          overrides: colors,
          expected: designOverrideExpectation(activeId, designTokens(current['overrides']), colors),
        },
        ['design.set'],
      );
      if (response['ok'] === false)
        throw Error(
          response['conflict'] === true
            ? t('designStudio.colorConflict')
            : String(response['error'] ?? t('designStudio.colorRefused')),
        );
      const saved = await command('design.list', {}, ['design.list']);
      if (
        saved['activeKit'] !== activeId ||
        !designValuesMatch(designTokens(saved['overrides']), colors)
      )
        throw Error(t('designStudio.colorUnconfirmed'));
      adopt(saved);
      setColors({});
      setColorBaseline(null);
      setContrast(null);
      setVerification(null);
      setNotice(t('designStudio.colorsSaved'));
    });
  };
  const saveTune = async () => {
    const patch = Object.fromEntries(Object.entries(tune).filter(([, value]) => value.trim()));
    if (!Object.keys(patch).length || dirty) return;
    await run(async () => {
      await currentActive();
      const result = await command('design.tune', { tune: patch, expected: { kit: activeId } }, [
        'design.tune',
      ]);
      if (result['ok'] === false)
        throw Error(
          result['conflict'] === true
            ? t('designStudio.activeChangedTune')
            : String(result['error'] ?? t('designStudio.tuneRefused')),
        );
      const saved = await command('design.list', {}, ['design.list']);
      if (
        saved['activeKit'] !== activeId ||
        !designValuesMatch(designTokens(saved['overrides']), designTokens(result['resolved']))
      )
        throw Error(t('designStudio.tuneReadback'));
      adopt(saved);
      setTune({});
      setContrast(null);
      setVerification(null);
      setNotice(t('designStudio.tuneSaved'));
    });
  };
  const write = async () => {
    setConfirmation(null);
    await run(async () => {
      await currentActive();
      const response = await materializeProjectTheme(command, stack, outPath);
      setWritten(response['path']);
      setContrast(entries(response['contrastIssues']));
      setNotice(t('designStudio.themeWritten', { path: response['path'] }));
    });
  };
  const verify = async () => {
    await run(async () => {
      const result = await command('design.verify', {}, ['design.verify'], { timeoutMs: 120000 });
      setVerification(result);
      setNotice(t('designStudio.scanReturned'));
    });
  };
  return (
    <section className="project-design-studio" aria-label={t('designStudio.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('designStudio.title')}</h1>
          <p>{t('designStudio.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy || dirty || tuneDirty}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          {t('designStudio.refresh')}
        </button>
      </header>
      <div className="design-extract-callout">
        <FileCode2 size={16} />
        <div>
          <strong>{t('designStudio.extractCalloutTitle')}</strong>
          <span>{t(onPrepare ? 'chatView.designBody' : 'designStudio.extractCalloutBody')}</span>
        </div>
        {onPrepare ? (
          <button
            type="button"
            className="button secondary small"
            aria-expanded={extractOpen}
            onClick={() => setExtractOpen((open) => !open)}
          >
            {t('designFlow.launch')}
          </button>
        ) : (
          <code>/design extract https://stripe.com 6</code>
        )}
      </div>
      {extractOpen && onPrepare && (
        <div className="design-studio-reference">
          <DesignExtractForm
            variant="studio"
            disabled={!target}
            onPrepare={(prompt) => (target ? onPrepare(target.id, prompt) : Promise.resolve(false))}
            target={
              agents.length ? (
                <label>
                  {t('projectKit.target')}
                  <select
                    value={target?.id ?? ''}
                    onChange={(event) => setConversation(event.target.value)}
                  >
                    <option value="">{t('projectKit.chooseConversation')}</option>
                    {agents.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : onNewSession ? (
                <button type="button" className="button secondary small" onClick={onNewSession}>
                  {t('topbar.newSession')}
                </button>
              ) : undefined
            }
          />
        </div>
      )}
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <DesignEditDraftNotice draft={editDraft} />
      {dirty && (
        <div className="design-draft-notice">
          <span>
            {isActive
              ? t('designStudio.colorEdits')
              : t('designStudio.colorEditsFor', { kit: activeId })}
          </span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setSelected(activeId)}
          >
            {t('designStudio.reviewColors')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => {
              setColors({});
              setColorBaseline(null);
            }}
          >
            {t('designStudio.discardColors')}
          </button>
        </div>
      )}
      {tuneDirty && (
        <div className="design-draft-notice">
          <span>{t('designStudio.tuneEdits')}</span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setSelected(activeId)}
          >
            {t('designStudio.reviewTune')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setTune({})}
          >
            {t('designStudio.discardTune')}
          </button>
        </div>
      )}
      <div className="design-gallery-controls">
        <label>
          <Search size={15} />
          <input
            aria-label={t('designStudio.search')}
            placeholder={t('designStudio.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>{t('designStudio.kitCount', { shown: filtered.length, total: kits.length })}</span>
        {activeId && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => setSelected(activeId)}
          >
            <Check size={13} />
            {t('designStudio.active', {
              name: String(kits.find((item) => item['id'] === activeId)?.['name'] ?? activeId),
            })}
          </button>
        )}
      </div>
      {loading && !kits.length ? (
        <p role="status">{t('designStudio.loading')}</p>
      ) : (
        <div className="design-studio-layout">
          <section className="design-gallery-grid" aria-label={t('designStudio.gallery')}>
            {filtered.map((item) => (
              <button
                type="button"
                key={String(item['id'])}
                aria-label={t('designStudio.preview', { name: item['name'] })}
                aria-pressed={selected === item['id']}
                onClick={() => setSelected(String(item['id']))}
                className={`design-gallery-card ${activeId === item['id'] ? 'design-gallery-active' : ''}`}
              >
                <div className="design-card-previews">
                  <DesignThemePreview
                    tokens={designTheme(
                      item['light'],
                      activeId === item['id'] ? overrides : {},
                      'light',
                    )}
                    label={t('designStudio.light')}
                    compact
                  />
                  <DesignThemePreview
                    tokens={designTheme(
                      item['dark'],
                      activeId === item['id'] ? overrides : {},
                      'dark',
                    )}
                    label={t('designStudio.dark')}
                    compact
                  />
                </div>
                <div className="design-card-copy">
                  <strong>
                    {String(item['name'])}
                    {activeId === item['id'] && <Check size={14} />}
                  </strong>
                  <span>{String(item['aesthetic'])}</span>
                  <small>{String(item['bestFor'])}</small>
                </div>
              </button>
            ))}
            {!filtered.length && (
              <div className="design-studio-empty">
                <Palette size={30} />
                <h2>{t('designStudio.noMatch')}</h2>
                <p>{t('designStudio.noMatchHint')}</p>
              </div>
            )}
          </section>
          <article className="design-studio-detail" aria-label={t('designStudio.details')}>
            {kit ? (
              <>
                <header>
                  <span className="eyebrow">
                    {isActive ? t('designStudio.activeEyebrow') : t('designStudio.exploreEyebrow')}
                  </span>
                  <h2>{String(kit['name'])}</h2>
                  <p>{String(kit['aesthetic'])}</p>
                  {typeof kit['material'] === 'string' && kit['material'].length > 0 && (
                    <p>{kit['material']}</p>
                  )}
                  <small>{String(kit['bestFor'])}</small>
                  <div className="design-kit-tags">
                    {Boolean(kit['axes']) && typeof kit['axes'] === 'object' && (
                      <span>
                        {`${String((kit['axes'] as Record<string, unknown>)['paper'] ?? '')}/${String((kit['axes'] as Record<string, unknown>)['display'] ?? '')}/${String((kit['axes'] as Record<string, unknown>)['accent'] ?? '')}`}
                      </span>
                    )}
                    {typeof kit['posture'] === 'string' && kit['posture'].length > 0 && (
                      <span>{kit['posture']}</span>
                    )}
                    {typeof kit['photo'] === 'string' && kit['photo'].length > 0 && (
                      <span>{`photo: ${kit['photo']}`}</span>
                    )}
                    {(Array.isArray(kit['tags']) ? kit['tags'] : []).map((tag, i) => (
                      <span key={i}>{String(tag)}</span>
                    ))}
                  </div>
                </header>
                <div className="design-focused-previews">
                  <DesignThemePreview
                    tokens={designTheme(kit['light'], shownOverrides, 'light')}
                    label={t('designStudio.light')}
                  />
                  <DesignThemePreview
                    tokens={designTheme(kit['dark'], shownOverrides, 'dark')}
                    label={t('designStudio.dark')}
                  />
                </div>
                <div className="design-pin-controls">
                  <label>
                    {t('designStudio.targetStack')}
                    <select
                      aria-label={t('designStudio.targetStackLabel')}
                      value={stack}
                      disabled={busy}
                      onChange={(e) => setStack(e.target.value)}
                    >
                      {(supportedStacks.length ? supportedStacks : ['web']).map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || dirty || tuneDirty}
                    onClick={() => (isActive ? void pin('design.use') : setConfirmation('use'))}
                  >
                    {isActive ? t('designStudio.reapply') : t('designStudio.use')}
                  </button>
                  {isActive && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || dirty || tuneDirty}
                      onClick={() => setConfirmation('swap')}
                    >
                      {t('designStudio.reset')}
                    </button>
                  )}
                </div>
                {confirmation === 'use' || confirmation === 'swap' ? (
                  <div className="design-action-confirm">
                    <h3>
                      {confirmation === 'swap'
                        ? t('designStudio.confirmSwapTitle')
                        : t('designStudio.confirmUseTitle', { name: kit['name'] })}
                    </h3>
                    <p>
                      {confirmation === 'swap'
                        ? t('designStudio.confirmSwapBody')
                        : t('designStudio.confirmUseBody')}
                    </p>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setConfirmation(null)}
                    >
                      {t('designStudio.keepKit')}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void pin(confirmation === 'swap' ? 'design.swap' : 'design.use')
                      }
                    >
                      {confirmation === 'swap'
                        ? t('designStudio.confirmSwap')
                        : t('designStudio.confirmUse')}
                    </button>
                  </div>
                ) : null}
                {isActive && (
                  <>
                    <section className="design-color-editor">
                      <header>
                        <h3>{t('designStudio.colors')}</h3>
                        <div>
                          {(['light', 'dark'] as const).map((name) => (
                            <button
                              type="button"
                              className="button secondary small"
                              key={name}
                              aria-pressed={colorTheme === name}
                              onClick={() => setColorTheme(name)}
                            >
                              {name === 'light'
                                ? t('designStudio.lightColors')
                                : t('designStudio.darkColors')}
                            </button>
                          ))}
                        </div>
                      </header>
                      <p>{t('designStudio.colorsHint')}</p>
                      <div className="design-color-fields">
                        {['primary', 'accent', 'bg', 'surface', 'fg', 'border'].map((key) => {
                          const values = designTheme(
                            kit[colorTheme],
                            { ...overrides, ...colors },
                            colorTheme,
                          );
                          const value = values[key] ?? '';
                          return (
                            <label key={`${colorTheme}.${key}`}>
                              <span>
                                <i
                                  style={{
                                    backgroundColor: designColorValue(value)
                                      ? value
                                      : 'transparent',
                                  }}
                                />
                                {t(`designStudio.color.${key}`)}
                              </span>
                              <input
                                aria-label={t('designStudio.colorField', {
                                  theme: t(`designStudio.themeWord.${colorTheme}`),
                                  name: t(`designStudio.colorWord.${key}`),
                                })}
                                value={value}
                                disabled={busy}
                                onChange={(e) => {
                                  if (!colorBaseline) setColorBaseline({ ...overrides });
                                  setColors((old) => ({
                                    ...old,
                                    [`${colorTheme}.${key}`]: e.target.value,
                                  }));
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                      {!validColors && <p role="alert">{t('designStudio.invalidColor')}</p>}
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || !dirty || !validColors}
                        onClick={() => void saveColors()}
                      >
                        {t('designStudio.saveColors')}
                      </button>
                    </section>
                    <section className="design-tune-editor">
                      <h3>{t('designStudio.shape')}</h3>
                      <div className="design-tune-fields">
                        {[
                          [
                            'radius',
                            t('designStudio.corners'),
                            ['none', 'sm', 'md', 'lg', 'xl', 'full'],
                          ],
                          [
                            'density',
                            t('designStudio.spacing'),
                            ['compact', 'cozy', 'comfortable'],
                          ],
                          ['motion', t('designStudio.motion'), ['snappy', 'smooth', 'none']],
                        ].map(([key, label, choices]) => (
                          <label key={String(key)}>
                            {String(label)}
                            <select
                              aria-label={t(`designStudio.tuneField.${String(key)}`)}
                              disabled={busy || dirty}
                              value={tune[String(key)] ?? ''}
                              onChange={(e) =>
                                setTune((old) => ({ ...old, [String(key)]: e.target.value }))
                              }
                            >
                              <option value="">{t('designStudio.keepCurrent')}</option>
                              {(choices as string[]).map((value) => (
                                <option key={value} value={value}>
                                  {t(`designStudio.choice.${value}`, { defaultValue: value })}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                        <label>
                          {t('designStudio.font')}
                          <input
                            aria-label={t('designStudio.fontField')}
                            placeholder={t('designStudio.keepCurrent')}
                            disabled={busy || dirty}
                            value={tune['font'] ?? ''}
                            onChange={(e) => setTune((old) => ({ ...old, font: e.target.value }))}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={
                          busy || dirty || !Object.values(tune).some((value) => value.trim())
                        }
                        onClick={() => void saveTune()}
                      >
                        {t('designStudio.saveTune')}
                      </button>
                    </section>
                    <section className="design-output">
                      <h3>{t('designStudio.writeTitle')}</h3>
                      <label>
                        {t('designStudio.outputFile')}
                        <input
                          aria-label={t('designStudio.outputLabel')}
                          value={outPath}
                          disabled={busy}
                          placeholder={t('designStudio.outputPlaceholder')}
                          onChange={(e) => setOutPath(e.target.value)}
                        />
                      </label>
                      <p>{t('designStudio.target', { stack })}</p>
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || dirty || tuneDirty}
                        onClick={() => setConfirmation('write')}
                      >
                        {t('designStudio.reviewOutput')}
                      </button>
                      {confirmation === 'write' && (
                        <div className="design-action-confirm">
                          <h4>
                            {t('designStudio.writeConfirm', {
                              path: outPath.trim() || t('designStudio.defaultThemeFile'),
                            })}
                          </h4>
                          <p>{t('designStudio.replaceWarning')}</p>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setConfirmation(null)}
                          >
                            {t('designStudio.keepReviewing')}
                          </button>
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => void write()}
                          >
                            {t('designStudio.writeTheme')}
                          </button>
                        </div>
                      )}
                      {written && (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => onOpenFile(written)}
                        >
                          <FileCode2 size={14} />
                          {t('designStudio.open', { path: written })}
                        </button>
                      )}
                    </section>
                  </>
                )}
                {isActive && contrast && (
                  <section className="design-contrast">
                    <h3>{t('designStudio.contrastTitle')}</h3>
                    {contrast.length ? (
                      contrast.map((issue, i) => (
                        <p key={i}>
                          {String(issue['theme'])} · {String(issue['pair'])} ·{' '}
                          {displayDecimal(Number(issue['ratio']), 2)}:1
                        </p>
                      ))
                    ) : (
                      <p>{t('designStudio.noContrast')}</p>
                    )}
                  </section>
                )}
                {body?.kit === selected && body.text && (
                  <details className="design-kit-guide">
                    <summary>{t('designStudio.guide')}</summary>
                    <MarkdownContent text={body.text} />
                  </details>
                )}
              </>
            ) : (
              <div className="design-studio-empty">
                <Palette size={32} />
                <h2>{t('designStudio.chooseTitle')}</h2>
                <p>{t('designStudio.chooseHint')}</p>
              </div>
            )}
            <section className="design-verification">
              <header>
                <h3>{t('designStudio.verifyTitle')}</h3>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || dirty || tuneDirty}
                  onClick={() => void verify()}
                >
                  <ShieldCheck size={14} />
                  {t('designStudio.scan')}
                </button>
              </header>
              <p>{t('designStudio.verifyHint')}</p>
              {verification && (
                <>
                  <p>
                    {t('designStudio.sourceLine', {
                      count: Number(verification['filesScanned'] ?? 0),
                      source:
                        verification['source'] === 'captured'
                          ? t('designStudio.sourceCaptured')
                          : t('designStudio.sourceKit', { kit: verification['kit'] ?? '' }),
                      score:
                        typeof verification['score'] === 'number'
                          ? t('designStudio.adherence', {
                              percent: Math.round(verification['score'] * 100),
                            })
                          : t('designStudio.noScore'),
                    })}
                  </p>
                  <p>
                    {t('designStudio.findings', {
                      count: Number(
                        verification['violationCount'] ??
                          entries(verification['violations']).length,
                      ),
                      shown: entries(verification['violations']).length,
                    })}
                  </p>
                  {typeof verification['filesWithNoSignal'] === 'number' && (
                    <p>
                      {t('designStudio.noSignal', { count: verification['filesWithNoSignal'] })}
                    </p>
                  )}
                  {Array.isArray(verification['capturedFrom']) && (
                    <p>
                      {t('designStudio.capturedFrom', {
                        list: verification['capturedFrom'].map(String).join(', '),
                      })}
                    </p>
                  )}
                  {entries(verification['violations']).map((item, i) => (
                    <article key={i}>
                      <button
                        type="button"
                        className="design-violation-file"
                        onClick={() => onOpenFile(String(item['file']))}
                      >
                        {String(item['file'])}:{String(item['line'])}
                      </button>
                      <small>
                        {String(item['severity'] ?? t('designStudio.observation'))} ·{' '}
                        {String(item['axis'] ?? 'color')}
                        {item['id'] ? ` · ${item['id']}` : ''}
                      </small>
                      <p>{String(item['reason'])}</p>
                      <code>{String(item['snippet'] ?? '')}</code>
                    </article>
                  ))}
                </>
              )}
            </section>
          </article>
        </div>
      )}
    </section>
  );
}
