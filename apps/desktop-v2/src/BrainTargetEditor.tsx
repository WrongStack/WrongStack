import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  type BrainSeatDefault,
  type BrainTarget,
  type BrainTargetsDraft,
  type BrainVoter,
  emptyBrainSeat,
  emptyBrainTarget,
  emptyBrainVoter,
} from './brain-targets-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import './brain-targets.css';

export function BrainTargetEditor({
  value,
  onChange,
  snapshot,
  command,
}: {
  value: BrainTargetsDraft;
  onChange: (value: BrainTargetsDraft) => void;
  snapshot: Record<string, unknown>;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  // Read through a ref so a language change does not reread the saved model catalogs.
  const words = useRef(t);
  words.current = t;
  const [catalog, setCatalog] = useState<{ provider: string; model: string }[]>([]),
    [catalogError, setCatalogError] = useState('');
  const lensId = useId();
  const personas = entries(snapshot['personaCatalog']);
  useEffect(() => {
    let active = true;
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then(async (reply) => {
        const results = await Promise.allSettled(
          entries(reply['providers']).map(async (provider) => {
            const id = String(provider['id']);
            const reply = await command('provider.models', { providerId: id }, [
              'provider.models',
              'key.operation_result',
            ]);
            return entries(reply['models'])
              .filter((row) => typeof row['id'] === 'string')
              .map((row) => ({ provider: id, model: String(row['id']) }));
          }),
        );
        if (active) {
          setCatalog(
            results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
          );
          if (results.some((result) => result.status === 'rejected'))
            setCatalogError(words.current('brainTargets.catalogPartial'));
        }
      })
      .catch((error) => {
        if (active) setCatalogError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [command]);
  const fields = (row: BrainTarget, label: string, update: (target: BrainTarget) => void) => {
    // The select names the saved entry the fields hold, or says they hold a custom model.
    const saved = catalog.findIndex(
      (entry) => entry.provider === row.provider && entry.model === row.model,
    );
    return (
      <div className="brain-target-fields">
        <label>
          {t('brainTargets.field.saved')}
          <select
            aria-label={t('brainTargets.field.savedLabel', { target: label })}
            value={saved < 0 ? '' : saved}
            onChange={(event) => {
              const choice = catalog[Number(event.target.value)];
              if (event.target.value !== '' && choice) update(choice);
            }}
          >
            <option value="">
              {saved < 0 && row.model.trim()
                ? t('brainTargets.field.custom')
                : t('brainTargets.field.choose')}
            </option>
            {catalog.map((entry, index) => (
              <option value={index} key={index}>
                {entry.provider}/{entry.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('brainTargets.field.provider')}
          <input
            aria-label={t('brainTargets.field.providerLabel', { target: label })}
            value={row.provider}
            placeholder={t('brainTargets.field.providerPlaceholder')}
            onChange={(event) => update({ ...row, provider: event.target.value })}
          />
        </label>
        <label>
          {t('brainTargets.field.model')}
          <input
            aria-label={t('brainTargets.field.modelLabel', { target: label })}
            value={row.model}
            placeholder={t('brainTargets.field.modelPlaceholder')}
            onChange={(event) => update({ ...row, model: event.target.value })}
          />
        </label>
      </div>
    );
  };
  const move = <T,>(items: T[], index: number, delta: number): T[] => {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    return next;
  };
  const actions = (
    label: string,
    index: number,
    length: number,
    reorder: (delta: number) => void,
    remove: () => void,
  ) => (
    <div className="brain-target-actions">
      <button
        type="button"
        className="icon-button"
        disabled={index === 0}
        aria-label={t('brainTargets.moveUp', { target: label })}
        onClick={() => reorder(-1)}
      >
        <ArrowUp size={15} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={index === length - 1}
        aria-label={t('brainTargets.moveDown', { target: label })}
        onClick={() => reorder(1)}
      >
        <ArrowDown size={15} />
      </button>
      <button
        type="button"
        className="icon-button danger"
        aria-label={t('brainTargets.remove', { target: label })}
        onClick={remove}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
  const changeVoter = (index: number, patch: Partial<BrainVoter>) =>
    onChange({
      ...value,
      voters: value.voters.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  return (
    <section className="brain-target-editor" aria-label={t('brainTargets.label')}>
      {catalogError && <p role="status">{catalogError}</p>}
      <article className="brain-policy-card">
        <header>
          <h3>{t('brainTargets.pool.title')}</h3>
          <p>{t('brainTargets.pool.help')}</p>
        </header>
        <label className="brain-pool-strategy">
          {t('brainTargets.pool.strategy')}
          <select
            aria-label={t('brainTargets.pool.strategyLabel')}
            value={value.strategy}
            onChange={(event) => onChange({ ...value, strategy: event.target.value })}
          >
            <option value="fallback">{t('brainTargets.pool.strategyOption.fallback')}</option>
            <option value="round-robin">{t('brainTargets.pool.strategyOption.round-robin')}</option>
          </select>
        </label>
        {value.pool.map((row, index) => (
          <div className="brain-target-row" key={index}>
            <header>
              <strong>{t('brainTargets.pool.row', { n: index + 1 })}</strong>
              {actions(
                t('brainTargets.pool.target', { n: index + 1 }),
                index,
                value.pool.length,
                (delta) => onChange({ ...value, pool: move(value.pool, index, delta) }),
                () => onChange({ ...value, pool: value.pool.filter((_, i) => i !== index) }),
              )}
            </header>
            {fields(row, t('brainTargets.pool.target', { n: index + 1 }), (target) =>
              onChange({
                ...value,
                pool: value.pool.map((old, i) => (i === index ? target : old)),
              }),
            )}
          </div>
        ))}
        {!value.pool.length && <p>{t('brainTargets.pool.inherited')}</p>}
        <button
          type="button"
          className="button secondary small"
          onClick={() => onChange({ ...value, pool: [...value.pool, emptyBrainTarget()] })}
        >
          <Plus size={14} />
          {t('brainTargets.pool.add')}
        </button>
        {value.pool.length > 0 && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => onChange({ ...value, pool: [] })}
          >
            {t('brainTargets.pool.inherit')}
          </button>
        )}
      </article>
      <article className="brain-policy-card">
        <header>
          <h3>{t('brainTargets.voters.title')}</h3>
          <p>{t('brainTargets.voters.help')}</p>
        </header>
        <datalist id={lensId}>
          {personas.map((persona) => (
            <option key={String(persona['id'])} value={String(persona['id'])}>
              {String(persona['name'])}
            </option>
          ))}
        </datalist>
        {value.voters.map((row, index) => (
          <div className="brain-target-row" key={index}>
            <header>
              <strong>{t('brainTargets.voters.row', { n: index + 1 })}</strong>
              {actions(
                t('brainTargets.voters.target', { n: index + 1 }),
                index,
                value.voters.length,
                (delta) => onChange({ ...value, voters: move(value.voters, index, delta) }),
                () => onChange({ ...value, voters: value.voters.filter((_, i) => i !== index) }),
              )}
            </header>
            {fields(row, t('brainTargets.voters.target', { n: index + 1 }), (target) =>
              changeVoter(index, target),
            )}
            <div className="brain-voter-policy">
              <label>
                {t('brainTargets.voters.lens')}
                <input
                  aria-label={t('brainTargets.voters.lensLabel', { n: index + 1 })}
                  list={lensId}
                  value={row.persona}
                  placeholder={t('brainTargets.voters.lensPlaceholder')}
                  onChange={(event) => changeVoter(index, { persona: event.target.value })}
                />
              </label>
              <label>
                {t('brainTargets.voters.weight')}
                <input
                  type="number"
                  min={Number.MIN_VALUE}
                  step="any"
                  aria-label={t('brainTargets.voters.weightLabel', { n: index + 1 })}
                  value={row.weight}
                  placeholder={t('brainTargets.voters.weightPlaceholder')}
                  onChange={(event) => changeVoter(index, { weight: event.target.value })}
                />
              </label>
              <label>
                {t('brainTargets.voters.veto')}
                <select
                  aria-label={t('brainTargets.voters.vetoLabel', { n: index + 1 })}
                  value={row.veto}
                  onChange={(event) =>
                    changeVoter(index, { veto: event.target.value as BrainVoter['veto'] })
                  }
                >
                  {['default', 'yes', 'no'].map((veto) => (
                    <option key={veto} value={veto}>
                      {t(`brainTargets.voters.vetoOption.${veto}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              {String(
                personas.find((persona) => persona['id'] === row.persona)?.['description'] ??
                  (row.persona
                    ? t('brainTargets.voters.customLens')
                    : t('brainTargets.voters.defaultLens')),
              )}
            </p>
          </div>
        ))}
        {!value.voters.length && <p>{t('brainTargets.voters.none')}</p>}
        <button
          type="button"
          className="button secondary small"
          onClick={() => onChange({ ...value, voters: [...value.voters, emptyBrainVoter()] })}
        >
          <Plus size={14} />
          {t('brainTargets.voters.add')}
        </button>
        {value.voters.length > 0 && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => onChange({ ...value, voters: [] })}
          >
            {t('brainTargets.voters.derive')}
          </button>
        )}
      </article>
      <article className="brain-policy-card" aria-label={t('brainTargets.seats.label')}>
        <header>
          <h3>{t('brainTargets.seats.title')}</h3>
          <p>{t('brainTargets.seats.help')}</p>
        </header>
        {!value.seats.length && <p>{t('brainTargets.seats.builtIn')}</p>}
        {value.seats.map((row, index) => {
          const change = (patch: Partial<BrainSeatDefault>) =>
            onChange({
              ...value,
              seats: value.seats.map((old, i) => (i === index ? { ...old, ...patch } : old)),
            });
          const persona = personas.find((entry) => entry['id'] === row.persona);
          return (
            <div className="brain-target-row" key={index}>
              <header>
                <strong>{t('brainTargets.seats.row', { n: index + 1 })}</strong>
                {actions(
                  t('brainTargets.seats.target', { n: index + 1 }),
                  index,
                  value.seats.length,
                  (delta) => onChange({ ...value, seats: move(value.seats, index, delta) }),
                  () => onChange({ ...value, seats: value.seats.filter((_, i) => i !== index) }),
                )}
              </header>
              <div className="brain-voter-policy">
                <label>
                  {t('brainTargets.voters.lens')}
                  <input
                    aria-label={t('brainTargets.seats.lensLabel', { n: index + 1 })}
                    list={lensId}
                    value={row.persona}
                    placeholder={t('brainTargets.seats.lensPlaceholder')}
                    onChange={(event) => change({ persona: event.target.value })}
                  />
                </label>
                <label>
                  {t('brainTargets.voters.veto')}
                  <select
                    aria-label={t('brainTargets.seats.vetoLabel', { n: index + 1 })}
                    value={row.veto}
                    onChange={(event) =>
                      change({ veto: event.target.value as BrainSeatDefault['veto'] })
                    }
                  >
                    <option value="default">{t('brainTargets.seats.lensDefault')}</option>
                    <option value="yes">{t('brainTargets.voters.vetoOption.yes')}</option>
                    <option value="no">{t('brainTargets.voters.vetoOption.no')}</option>
                  </select>
                </label>
              </div>
              <p>
                {String(
                  persona?.['description'] ??
                    (row.persona
                      ? t('brainTargets.voters.customLens')
                      : t('brainTargets.seats.lensRequired')),
                )}
              </p>
              {row.veto === 'default' && (
                <p>
                  {persona?.['defaultVeto'] === true
                    ? t('brainTargets.seats.vetoOn')
                    : t('brainTargets.seats.vetoUnknown')}
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="button secondary small"
          onClick={() => onChange({ ...value, seats: [...value.seats, emptyBrainSeat()] })}
        >
          <Plus size={14} /> {t('brainTargets.seats.add')}
        </button>
        {value.seats.length > 0 && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => onChange({ ...value, seats: [] })}
          >
            {t('brainTargets.seats.builtInUse')}
          </button>
        )}
      </article>
      <article className="brain-policy-card">
        <h3>{t('brainTargets.judge.title')}</h3>
        <p>{t('brainTargets.judge.help')}</p>
        {fields(value.judge, t('brainTargets.judge.title'), (judge) =>
          onChange({ ...value, judge }),
        )}
        <button
          type="button"
          className="button secondary small"
          disabled={!value.judge.model && !value.judge.provider}
          onClick={() => onChange({ ...value, judge: emptyBrainTarget() })}
        >
          {t('brainTargets.judge.derive')}
        </button>
      </article>
    </section>
  );
}
