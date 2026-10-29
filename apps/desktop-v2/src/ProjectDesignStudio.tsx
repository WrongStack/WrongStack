import { Check, FileCode2, Palette, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DesignEditDraftNotice, useDesignEditDraft } from './DesignEditDraftNotice';
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
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import './project-design-studio.css';

export function ProjectDesignStudio({
  projectId,
  command,
  onOpenFile,
}: {
  projectId: string;
  command: EngineCommand;
  onOpenFile: (path: string) => void;
}) {
  const [catalog, setCatalog] = useState<Record<string, unknown>>({});
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
  const filtered = kits.filter((item) =>
    `${item['name']} ${item['id']} ${item['aesthetic']} ${Array.isArray(item['tags']) ? item['tags'].join(' ') : ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
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
    if (fresh['activeKit'] !== activeId)
      throw Error('The project’s active kit changed. Refresh the gallery before editing it.');
    return fresh;
  };
  const pin = async (type: 'design.use' | 'design.swap') => {
    if (!kit || dirty || tuneDirty) return;
    setConfirmation(null);
    await run(async () => {
      const response = await command(type, { kit: selected, stack }, [type]);
      const saved = await command('design.list', {}, ['design.list']);
      if (saved['activeKit'] !== selected || saved['stack'] !== stack)
        throw Error('The active kit changed before readback. Refresh the project gallery.');
      adopt(saved);
      setBody({ kit: selected, text: String(response['body'] ?? '') });
      setContrast(
        Array.isArray(response['contrastIssues']) ? entries(response['contrastIssues']) : null,
      );
      setVerification(null);
      setWritten('');
      setTune({});
      setNotice(
        type === 'design.swap'
          ? 'Project kit replaced and saved overrides reset.'
          : 'Project design kit saved.',
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
        throw Error(
          'A color you edited changed in another window. Your draft is retained; refresh after copying or discarding it.',
        );
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
            ? 'A color you edited changed in another window. Your draft is retained; refresh after copying or discarding it.'
            : String(response['error'] ?? 'The color save was refused. Your draft is retained.'),
        );
      const saved = await command('design.list', {}, ['design.list']);
      if (
        saved['activeKit'] !== activeId ||
        !designValuesMatch(designTokens(saved['overrides']), colors)
      )
        throw Error('The color save could not be confirmed. Your draft is retained.');
      adopt(saved);
      setColors({});
      setColorBaseline(null);
      setContrast(null);
      setVerification(null);
      setNotice('Project color overrides saved and verified.');
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
            ? 'The project’s active kit changed. Refresh the gallery before tuning it.'
            : String(result['error'] ?? 'The tuning was refused.'),
        );
      const saved = await command('design.list', {}, ['design.list']);
      if (
        saved['activeKit'] !== activeId ||
        !designValuesMatch(designTokens(saved['overrides']), designTokens(result['resolved']))
      )
        throw Error('The tuning readback changed. Refresh before continuing.');
      adopt(saved);
      setTune({});
      setContrast(null);
      setVerification(null);
      setNotice('Project shape, spacing and typography settings saved.');
    });
  };
  const write = async () => {
    setConfirmation(null);
    await run(async () => {
      await currentActive();
      const response = await materializeProjectTheme(command, stack, outPath);
      setWritten(response['path']);
      setContrast(entries(response['contrastIssues']));
      setNotice(`Theme written and read back: ${response['path']}`);
    });
  };
  const verify = async () => {
    await run(async () => {
      const result = await command('design.verify', {}, ['design.verify'], { timeoutMs: 120000 });
      setVerification(result);
      setNotice('The engine returned the project design scan.');
    });
  };
  return (
    <section className="project-design-studio" aria-label="Project Design Studio">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">A VISUAL LANGUAGE FOR YOUR PROJECT</span>
          <h1>
            Design Studio<span className="heading-dot">.</span>
          </h1>
          <p>
            Explore real light and dark themes, shape their details, and write the theme into your
            project.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy || dirty || tuneDirty}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh design gallery
        </button>
      </header>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <DesignEditDraftNotice draft={editDraft} />
      {dirty && (
        <div className="design-draft-notice">
          <span>Unsaved project color edits{!isActive ? ` for ${activeId}` : ''}.</span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setSelected(activeId)}
          >
            Review color edits
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
            Discard color edits
          </button>
        </div>
      )}
      {tuneDirty && (
        <div className="design-draft-notice">
          <span>
            Unsaved project shape and typography edits. Save or discard them before changing kits or
            writing a theme.
          </span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setSelected(activeId)}
          >
            Review tuning edits
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => setTune({})}
          >
            Discard tuning edits
          </button>
        </div>
      )}
      <div className="design-gallery-controls">
        <label>
          <Search size={15} />
          <input
            aria-label="Search design kits"
            placeholder="Find an aesthetic, kit or tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>
          {filtered.length} of {kits.length} kits
        </span>
        {activeId && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => setSelected(activeId)}
          >
            <Check size={13} />
            Active: {String(kits.find((item) => item['id'] === activeId)?.['name'] ?? activeId)}
          </button>
        )}
      </div>
      {loading && !kits.length ? (
        <p role="status">Loading project design kits…</p>
      ) : (
        <div className="design-studio-layout">
          <section className="design-gallery-grid" aria-label="Design kit gallery">
            {filtered.map((item) => (
              <button
                type="button"
                key={String(item['id'])}
                aria-label={`Preview ${item['name']}`}
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
                    label="Light"
                    compact
                  />
                  <DesignThemePreview
                    tokens={designTheme(
                      item['dark'],
                      activeId === item['id'] ? overrides : {},
                      'dark',
                    )}
                    label="Dark"
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
                <h2>No kits match this view.</h2>
                <p>Refresh the catalog or try a different search.</p>
              </div>
            )}
          </section>
          <article className="design-studio-detail" aria-label="Design kit details">
            {kit ? (
              <>
                <header>
                  <span className="eyebrow">
                    {isActive ? 'ACTIVE PROJECT KIT' : 'EXPLORE THIS DESIGN'}
                  </span>
                  <h2>{String(kit['name'])}</h2>
                  <p>{String(kit['aesthetic'])}</p>
                  <small>{String(kit['bestFor'])}</small>
                  <div className="design-kit-tags">
                    {(Array.isArray(kit['tags']) ? kit['tags'] : []).map((tag, i) => (
                      <span key={i}>{String(tag)}</span>
                    ))}
                  </div>
                </header>
                <div className="design-focused-previews">
                  <DesignThemePreview
                    tokens={designTheme(kit['light'], shownOverrides, 'light')}
                    label="Light"
                  />
                  <DesignThemePreview
                    tokens={designTheme(kit['dark'], shownOverrides, 'dark')}
                    label="Dark"
                  />
                </div>
                <div className="design-pin-controls">
                  <label>
                    Target stack
                    <select
                      aria-label="Design target stack"
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
                    {isActive ? 'Reapply active project kit' : 'Use kit for project'}
                  </button>
                  {isActive && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || dirty || tuneDirty}
                      onClick={() => setConfirmation('swap')}
                    >
                      Reset kit overrides
                    </button>
                  )}
                </div>
                {confirmation === 'use' || confirmation === 'swap' ? (
                  <div className="design-action-confirm">
                    <h3>
                      {confirmation === 'swap'
                        ? 'Reset this kit’s saved overrides?'
                        : `Use ${kit['name']} for this project?`}
                    </h3>
                    <p>
                      {confirmation === 'swap'
                        ? 'This starts from the kit’s original palette, shape and typography.'
                        : 'The project’s pinned kit and target stack will change. Overrides from the previous kit are not carried over.'}
                    </p>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setConfirmation(null)}
                    >
                      Keep current kit
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void pin(confirmation === 'swap' ? 'design.swap' : 'design.use')
                      }
                    >
                      {confirmation === 'swap' ? 'Confirm reset overrides' : 'Confirm project kit'}
                    </button>
                  </div>
                ) : null}
                {isActive && (
                  <>
                    <section className="design-color-editor">
                      <header>
                        <h3>Project colors</h3>
                        <div>
                          {(['light', 'dark'] as const).map((name) => (
                            <button
                              type="button"
                              className="button secondary small"
                              key={name}
                              aria-pressed={colorTheme === name}
                              onClick={() => setColorTheme(name)}
                            >
                              {name === 'light' ? 'Light colors' : 'Dark colors'}
                            </button>
                          ))}
                        </div>
                      </header>
                      <p>Preview changes here, then save them to the project’s kit.</p>
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
                                {
                                  (
                                    {
                                      primary: 'Primary',
                                      accent: 'Accent',
                                      bg: 'Background',
                                      surface: 'Surface',
                                      fg: 'Text',
                                      border: 'Border',
                                    } as Record<string, string>
                                  )[key]
                                }
                              </span>
                              <input
                                aria-label={`Design ${colorTheme} ${key}`}
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
                      {!validColors && (
                        <p role="alert">
                          Enter a supported CSS color, such as a hex, RGB or OKLCH value.
                        </p>
                      )}
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || !dirty || !validColors}
                        onClick={() => void saveColors()}
                      >
                        Save project colors
                      </button>
                    </section>
                    <section className="design-tune-editor">
                      <h3>Shape and rhythm</h3>
                      <div className="design-tune-fields">
                        {[
                          ['radius', 'Corners', ['none', 'sm', 'md', 'lg', 'xl', 'full']],
                          ['density', 'Spacing', ['compact', 'cozy', 'comfortable']],
                          ['motion', 'Motion', ['snappy', 'smooth', 'none']],
                        ].map(([key, label, choices]) => (
                          <label key={String(key)}>
                            {String(label)}
                            <select
                              aria-label={`Design ${String(key)}`}
                              disabled={busy || dirty}
                              value={tune[String(key)] ?? ''}
                              onChange={(e) =>
                                setTune((old) => ({ ...old, [String(key)]: e.target.value }))
                              }
                            >
                              <option value="">Keep current</option>
                              {(choices as string[]).map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                        ))}
                        <label>
                          Font family
                          <input
                            aria-label="Design font family"
                            placeholder="Keep current"
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
                        Save project tuning
                      </button>
                    </section>
                    <section className="design-output">
                      <h3>Write the theme to your project</h3>
                      <label>
                        Output file
                        <input
                          aria-label="Design output path"
                          value={outPath}
                          disabled={busy}
                          placeholder="Use the engine’s default theme path"
                          onChange={(e) => setOutPath(e.target.value)}
                        />
                      </label>
                      <p>
                        Target: {stack}. The engine writes the active kit with its saved overrides.
                      </p>
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || dirty || tuneDirty}
                        onClick={() => setConfirmation('write')}
                      >
                        Review theme output
                      </button>
                      {confirmation === 'write' && (
                        <div className="design-action-confirm">
                          <h4>Write {outPath.trim() || 'the default theme file'}?</h4>
                          <p>This can replace an existing theme file at the selected path.</p>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setConfirmation(null)}
                          >
                            Keep reviewing output
                          </button>
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => void write()}
                          >
                            Write project theme
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
                          Open {written}
                        </button>
                      )}
                    </section>
                  </>
                )}
                {isActive && contrast && (
                  <section className="design-contrast">
                    <h3>Token contrast observations</h3>
                    {contrast.length ? (
                      contrast.map((issue, i) => (
                        <p key={i}>
                          {String(issue['theme'])} · {String(issue['pair'])} ·{' '}
                          {Number(issue['ratio']).toFixed(2)}:1
                        </p>
                      ))
                    ) : (
                      <p>No low-contrast pairs reported for the last activation or theme output.</p>
                    )}
                  </section>
                )}
                {body?.kit === selected && body.text && (
                  <details className="design-kit-guide">
                    <summary>Kit implementation guide</summary>
                    <MarkdownContent text={body.text} />
                  </details>
                )}
              </>
            ) : (
              <div className="design-studio-empty">
                <Palette size={32} />
                <h2>Choose a visual direction.</h2>
                <p>Select a kit to inspect both themes and its supported stacks.</p>
              </div>
            )}
            <section className="design-verification">
              <header>
                <h3>Project design verification</h3>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || dirty || tuneDirty}
                  onClick={() => void verify()}
                >
                  <ShieldCheck size={14} />
                  Scan project design
                </button>
              </header>
              <p>
                Checks project UI signals against the pinned kit or captured tokens. The reported
                score measures color adherence.
              </p>
              {verification && (
                <>
                  <p>
                    Source:{' '}
                    {verification['source'] === 'captured'
                      ? 'Captured project tokens'
                      : `Kit ${verification['kit'] ?? ''}`}{' '}
                    · {String(verification['filesScanned'] ?? 0)} files ·{' '}
                    {typeof verification['score'] === 'number'
                      ? `${Math.round(verification['score'] * 100)}% reported color adherence`
                      : 'Color score not reported'}
                  </p>
                  <p>
                    {String(
                      verification['violationCount'] ?? entries(verification['violations']).length,
                    )}{' '}
                    findings · showing {entries(verification['violations']).length}
                  </p>
                  {typeof verification['filesWithNoSignal'] === 'number' && (
                    <p>
                      {verification['filesWithNoSignal']} files had no matching UI signals. Their
                      visual quality was not measured by this scan.
                    </p>
                  )}
                  {Array.isArray(verification['capturedFrom']) && (
                    <p>Captured from: {verification['capturedFrom'].map(String).join(', ')}</p>
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
                        {String(item['severity'] ?? 'Observation')} ·{' '}
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
