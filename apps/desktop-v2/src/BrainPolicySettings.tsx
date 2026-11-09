import { Brain, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { BrainPolicyEvidence } from './BrainPolicyEvidence';
import { BrainRules } from './BrainRules';
import { BrainTargetEditor } from './BrainTargetEditor';
import {
  type BrainDraft,
  type BrainField,
  brainDraft,
  brainGroups,
  brainMonitorResetPatch,
  brainPatch,
  brainSnapshot,
  brainValue,
} from './brain-policy-model';
import {
  type BrainTargetsDraft,
  type BrainTargetWords,
  brainTargetsDraft,
  brainTargetsPatch,
  mergeBrainPatches,
  verifyBrainTargets,
} from './brain-targets-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { durationText, record } from './engine-values';
import { sameSetting } from './settings-save-model';
import { surfaceI18n } from './surface-i18n';
import './brain-policy.css';

export function BrainPolicySettings({ command }: { command: EngineCommand }) {
  const { t, i18n } = useDesktopText();
  // Read through a ref so a language change does not reread the Brain configuration.
  const words = useRef(t);
  words.current = t;
  const label = (field: BrainField) =>
    t(`brainPolicy.field.${field.key}.label`, { defaultValue: field.label });
  const targetWords: BrainTargetWords = {
    pool: (n) => t('brainTargets.pool.target', { n }),
    voter: (n) => t('brainTargets.voters.target', { n }),
    judge: t('brainTargets.judge.title'),
    needsModel: (target) => t('brainTargets.error.needsModel', { target }),
    strategy: t('brainTargets.error.strategy'),
    seatLens: (n) => t('brainTargets.error.seatLens', { n }),
    seatVeto: t('brainTargets.error.seatVeto'),
    weight: (n) => t('brainTargets.error.weight', { n }),
    voterVeto: t('brainTargets.error.voterVeto'),
    changed: (part) => t('brainTargets.error.changed', { part: t(`brainTargets.part.${part}`) }),
    mismatch: (part) => t('brainTargets.error.mismatch', { part: t(`brainTargets.part.${part}`) }),
  };
  const policy = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [base, setBase] = useState<BrainDraft>({}),
    [draft, setDraft] = useState<BrainDraft>({});
  const [targetBase, setTargetBase] = useState<BrainTargetsDraft>(() => brainTargetsDraft({}));
  const [targets, setTargets] = useState<BrainTargetsDraft>(() => brainTargetsDraft({}));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [resetMonitor, setResetMonitor] = useState(false);
  const generation = useRef(0),
    saving = useRef(false);
  const read = useCallback(
    async () =>
      brainSnapshot(
        await command('brain.config.get', {}, ['brain.config', 'key.operation_result']),
        words.current('brainPolicy.error.unreadable'),
      ),
    [command],
  );
  const accept = (config: Record<string, unknown>) => {
    setResetMonitor(false);
    setSnapshot(config);
    const values = brainDraft(config);
    setBase(values);
    setDraft(values);
    const modelValues = brainTargetsDraft(config);
    setTargetBase(modelValues);
    setTargets(modelValues);
  };
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const config = await read();
      if (current === generation.current) accept(config);
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, [read]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const dirty = [
    ...(resetMonitor ? ['monitor reset'] : []),
    ...Object.keys(draft).filter((key) => !sameSetting(draft[key], base[key])),
    ...(['pool', 'strategy', 'voters', 'seats', 'judge'] as const).filter(
      (key) => !sameSetting(targets[key], targetBase[key]),
    ),
  ];
  const change = (key: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  };
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const live = await read();
      const policyDraft = resetMonitor
        ? {
            ...draft,
            ...Object.fromEntries(
              Object.entries(base).filter(([key]) => key.startsWith('monitor.')),
            ),
          }
        : draft;
      const patch = mergeBrainPatches(
        {
          ...brainPatch(base, policyDraft, brainDraft(live), live, {
            label,
            changed: (name) => t('brainPolicy.error.changed', { label: name }),
            number: (name, whole) =>
              t(whole ? 'brainPolicy.error.wholeNumber' : 'brainPolicy.error.number', {
                label: name,
              }),
            choice: (name) => t('brainPolicy.error.choice', { label: name }),
            toggle: (name) => t('brainPolicy.error.toggle', { label: name }),
            signals: t('brainPolicy.error.signals'),
          }),
          ...(resetMonitor
            ? brainMonitorResetPatch(snapshot ?? {}, live, t('brainPolicy.error.monitorChanged'))
            : {}),
        },
        brainTargetsPatch(targetBase, targets, brainTargetsDraft(live), targetWords),
      );
      if (!Object.keys(patch).length) {
        if (current === generation.current) {
          accept(live);
          setNotice(t('brainPolicy.alreadySaved'));
        }
        return;
      }
      const result = await command('brain.config.set', { patch }, [
        'brain.config',
        'key.operation_result',
      ]);
      if (result['persisted'] !== true) throw Error(t('brainPolicy.error.notPersisted'));
      const saved = await read();
      if (resetMonitor && Object.keys(record(saved['monitor'])).length)
        throw Error(t('brainPolicy.error.monitorNotCleared'));
      verifyBrainTargets(patch, saved, targetWords);
      for (const field of brainGroups.flatMap((group) => group.fields)) {
        const desired = brainValue(patch, field.key);
        if (
          desired !== undefined &&
          desired !== null &&
          !sameSetting(
            desired,
            field.kind === 'text'
              ? String(brainValue(saved, field.read ?? field.key) ?? '')
              : brainValue(saved, field.read ?? field.key),
          )
        )
          throw Error(t('brainPolicy.error.mismatch', { label: label(field) }));
      }
      if (current === generation.current) {
        accept(saved);
        setNotice(t('brainPolicy.savedVerified'));
      }
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const cache = record(snapshot?.['cache']),
    council = record(snapshot?.['council']);
  return (
    <section className="brain-policy" aria-label={t('brainPolicy.label')} ref={policy}>
      <header>
        <div>
          <span className="eyebrow">{t('brainPolicy.eyebrow')}</span>
          <h2>
            <Brain size={24} /> {t('brainPolicy.title')}
          </h2>
          <p>{t('brainPolicy.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
          {dirty.length ? t('brainPolicy.reloadDiscard') : t('brainPolicy.refresh')}
        </button>
      </header>
      <p className="brain-scope-note settings-defaults-note">{t('brainPolicy.scope')}</p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="feature-notice">
          {notice}
        </p>
      )}
      {!snapshot ? (
        <p role="status">{busy ? t('brainPolicy.reading') : t('brainPolicy.unavailable')}</p>
      ) : (
        <>
          <div className="brain-facts">
            {(
              [
                ['hits', cache['hits']],
                ['misses', cache['misses']],
                ['size', cache['size']],
              ] as const
            ).map(([fact, value]) => (
              <span key={fact}>
                <Trans
                  i18n={surfaceI18n}
                  ns="desktop"
                  i18nKey={`brainPolicy.fact.${fact}`}
                  {...(typeof value === 'number' ? { count: value } : {})}
                  values={{ n: String(value ?? '—') }}
                  components={{ strong: <strong /> }}
                />
              </span>
            ))}
            <span>
              <Trans
                i18n={surfaceI18n}
                ns="desktop"
                i18nKey="brainPolicy.fact.council"
                values={{
                  state:
                    council['enabled'] === true
                      ? t('brainPolicy.fact.active')
                      : t('brainPolicy.fact.inactive'),
                }}
                components={{ strong: <strong /> }}
              />
            </span>
          </div>
          <BrainRules snapshot={snapshot} />
          <nav className="brain-jump" aria-label={t('brainPolicy.jumpLabel')}>
            <span>{t('brainPolicy.jump')}</span>
            {[
              { id: 'models', title: t('brainPolicy.models') },
              ...brainGroups.map((group, index) => ({
                id: String(index),
                title: t(`brainPolicy.group.${group.id}.title`, { defaultValue: group.title }),
              })),
            ].map((group) => (
              <button
                type="button"
                key={group.id}
                onClick={() =>
                  policy.current
                    ?.querySelector<HTMLElement>(`[data-brain-group="${group.id}"]`)
                    ?.scrollIntoView({ block: 'start' })
                }
              >
                {group.title}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy} className="brain-policy-fields">
              <div data-brain-group="models">
                <BrainTargetEditor
                  value={targets}
                  snapshot={snapshot}
                  command={command}
                  onChange={(next) => {
                    setTargets(next);
                    setNotice('');
                  }}
                />
              </div>
              {brainGroups.map((group, index) => (
                <article className="brain-policy-card" key={group.title} data-brain-group={index}>
                  <header>
                    <h3>
                      {t(`brainPolicy.group.${group.id}.title`, { defaultValue: group.title })}
                    </h3>
                    <p>
                      {t(`brainPolicy.group.${group.id}.description`, {
                        defaultValue: group.description,
                      })}
                    </p>
                  </header>
                  {group.id === 'monitor' && (
                    <div className="brain-monitor-reset">
                      <p>
                        {resetMonitor
                          ? t('brainPolicy.monitor.preview')
                          : Object.keys(record(snapshot['monitor'])).length
                            ? t('brainPolicy.monitor.overridden')
                            : t('brainPolicy.monitor.inherited')}
                      </p>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={
                          !resetMonitor &&
                          !Object.keys(record(snapshot['monitor'])).length &&
                          !Object.keys(draft).some(
                            (key) =>
                              key.startsWith('monitor.') && !sameSetting(draft[key], base[key]),
                          )
                        }
                        onClick={() => {
                          const monitor = resetMonitor ? base : brainDraft({ monitor: {} });
                          setDraft((current) => ({
                            ...current,
                            ...Object.fromEntries(
                              Object.entries(monitor).filter(([key]) => key.startsWith('monitor.')),
                            ),
                          }));
                          setResetMonitor(!resetMonitor);
                          setError('');
                          setNotice('');
                        }}
                      >
                        {resetMonitor
                          ? t('brainPolicy.monitor.keep')
                          : t('brainPolicy.monitor.reset')}
                      </button>
                    </div>
                  )}
                  <div className="brain-field-grid">
                    {group.fields.map((field) => (
                      <label
                        htmlFor={`brain-${field.key}`}
                        className={`brain-field ${field.kind === 'toggle' ? 'brain-toggle' : ''}`}
                        key={field.key}
                      >
                        <span>
                          <strong>{label(field)}</strong>
                          <small>
                            {t(`brainPolicy.field.${field.key}.help`, { defaultValue: field.help })}
                          </small>
                        </span>
                        {field.kind === 'toggle' ? (
                          <input
                            id={`brain-${field.key}`}
                            type="checkbox"
                            aria-label={label(field)}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            checked={draft[field.key] === true}
                            onChange={(event) => change(field.key, event.target.checked)}
                          />
                        ) : field.kind === 'select' ? (
                          <select
                            id={`brain-${field.key}`}
                            aria-label={label(field)}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            required={!field.optional}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => change(field.key, event.target.value)}
                          >
                            {field.optional && (
                              <option value="">{t('brainPolicy.automatic')}</option>
                            )}
                            {field.options?.map((value) => (
                              <option key={value} value={value}>
                                {value === 'true'
                                  ? t('brainPolicy.enabled')
                                  : value === 'false'
                                    ? t('brainPolicy.disabled')
                                    : t(`brainPolicy.option.${value}`, {
                                        defaultValue: value.replaceAll('-', ' '),
                                      })}
                              </option>
                            ))}
                          </select>
                        ) : field.kind === 'lines' ? (
                          <textarea
                            id={`brain-${field.key}`}
                            aria-label={label(field)}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            rows={5}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => change(field.key, event.target.value)}
                          />
                        ) : (
                          <input
                            id={`brain-${field.key}`}
                            type={field.kind === 'text' ? 'text' : 'number'}
                            aria-label={label(field)}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            min={field.seconds ? (field.min ?? 0) / 1000 : field.min}
                            max={field.seconds && field.max ? field.max / 1000 : field.max}
                            step={field.seconds ? 'any' : (field.step ?? 1)}
                            required={field.kind === 'number' && !field.optional}
                            value={String(draft[field.key] ?? '')}
                            placeholder={field.optional ? t('brainPolicy.inherit') : undefined}
                            onChange={(event) => change(field.key, event.target.value)}
                          />
                        )}
                        {field.seconds && Number(draft[field.key]) >= 60 && (
                          <small className="brain-duration">
                            {durationText(Number(draft[field.key]) * 1000, i18n.language)}
                          </small>
                        )}
                      </label>
                    ))}
                  </div>
                </article>
              ))}
            </fieldset>
            <div className="brain-save-bar">
              <span>
                {dirty.length
                  ? t('brainPolicy.unsaved', { n: dirty.length })
                  : t('brainPolicy.matches')}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !dirty.length}
                onClick={() => {
                  setDraft(base);
                  setResetMonitor(false);
                  setTargets(targetBase);
                  setError('');
                  setNotice('');
                }}
              >
                {t('brainPolicy.discard')}
              </button>
              <button type="submit" className="button primary" disabled={busy || !dirty.length}>
                <Save size={14} />
                {busy ? t('brainPolicy.saving') : t('brainPolicy.save')}
              </button>
            </div>
          </form>
          <BrainPolicyEvidence snapshot={snapshot} />
        </>
      )}
    </section>
  );
}
