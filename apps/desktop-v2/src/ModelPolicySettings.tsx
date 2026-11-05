import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { FallbackSuggestions } from './FallbackSuggestions';
import { validSettingsName, withoutSetting } from './settings-save-model';

type Row = Record<string, unknown>;
export interface PolicyProps {
  draft: Row;
  change: (key: string, value: unknown) => void;
  command: EngineCommand;
}
export function ModelCatalog({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const id = useId();
  const [models, setModels] = useState<string[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then(async (reply) => {
        const results = await Promise.allSettled(
          entries(reply['providers']).map(async (provider) => {
            const id = String(provider['id']);
            const result = await command('provider.models', { providerId: id }, [
              'provider.models',
              'key.operation_result',
            ]);
            return entries(result['models']).map((model) => id + '/' + model['id']);
          }),
        );
        if (live) {
          setModels([
            ...new Set(
              results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
            ),
          ]);
          if (results.some((result) => result.status === 'rejected'))
            setError(t('modelPolicy.catalogError'));
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [command, t]);
  return (
    <>
      <datalist id={id}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {error && (
        <p className="field-help" role="status">
          {error}
        </p>
      )}
      <span hidden data-model-catalog={id} />
    </>
  );
}
export function ModelReference({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  /** Accessible name when the visible label leans on a heading (a tier card's field). */
  name?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useDesktopText();
  // A datalist keeps unavailable or custom stored references visible and editable.
  const [catalog, setCatalog] = useState<string>();
  useEffect(() => {
    setCatalog(
      document.querySelector<HTMLElement>('[data-model-catalog]')?.dataset['modelCatalog'],
    );
  }, []);
  return (
    <label>
      {label}
      <input
        aria-label={name ?? label}
        list={catalog}
        value={value}
        placeholder={t('modelPolicy.refPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function OrderedModelChain({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: string[]) => void;
}) {
  const { t } = useDesktopText();
  const chain = Array.isArray(value) ? value.map(String) : [];
  const move = (i: number, delta: number) => {
    const next = [...chain];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    onChange(next);
  };
  return (
    <section className="policy-chain" aria-label={label}>
      <header>
        <h3>{label}</h3>
        <span>{t('modelPolicy.chainCount', { number: chain.length })}</span>
      </header>
      {chain.map((model, i) => (
        <div className="policy-chain-row" key={i}>
          <span className="policy-order">{i + 1}</span>
          <ModelReference
            label={t('modelPolicy.chainModel', { label, number: i + 1 })}
            value={model}
            onChange={(v) => onChange(chain.map((old, n) => (n === i ? v : old)))}
          />
          <button
            type="button"
            className="icon-button"
            disabled={i === 0}
            aria-label={t('modelPolicy.moveUp', { label, number: i + 1 })}
            onClick={() => move(i, -1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={i === chain.length - 1}
            aria-label={t('modelPolicy.moveDown', { label, number: i + 1 })}
            onClick={() => move(i, 1)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button danger"
            aria-label={t('modelPolicy.removeModel', { label, number: i + 1 })}
            onClick={() => onChange(chain.filter((_, n) => n !== i))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!chain.length && <p className="field-help">{t('modelPolicy.noModels')}</p>}
      <button
        type="button"
        className="button secondary small"
        onClick={() => onChange([...chain, ''])}
      >
        <Plus size={13} />
        {t('modelPolicy.addModel')}
      </button>
    </section>
  );
}
export function FallbackPolicySettings({ draft, change, command }: PolicyProps) {
  const { t } = useDesktopText();
  const profiles = record(draft['fallbackProfiles']);
  const [name, setName] = useState(''),
    [error, setError] = useState('');
  const add = () => {
    const id = name.trim();
    if (!validSettingsName(id) || Object.hasOwn(profiles, id)) {
      setError(t('modelPolicy.uniqueProfile'));
      return;
    }
    change('fallbackProfiles', { ...profiles, [id]: [] });
    setName('');
    setError('');
  };
  const refs = (name: string) =>
    draft['refinerFallbackProfile'] === name ||
    draft['autoReviewFallbackProfile'] === name ||
    Object.values(record(draft['modelMatrix'])).some(
      (v) => record(v)['fallbackProfile'] === name,
    ) ||
    Object.values(record(record(draft['modelTiers'])['levels'])).some(
      (v) => record(v)['fallbackProfile'] === name,
    );
  return (
    <div className="model-policy-settings">
      <ModelCatalog command={command} />
      <p className="settings-defaults-note">{t('modelPolicy.fallbackIntro')}</p>
      <OrderedModelChain
        label={t('modelPolicy.defaultChain')}
        value={draft['fallbackModels']}
        onChange={(v) => change('fallbackModels', v)}
      />
      <FallbackSuggestions
        command={command}
        draft={draft}
        onUse={(chain) => change('fallbackModels', chain)}
        onSaveProfile={(id, chain) => change('fallbackProfiles', { ...profiles, [id]: chain })}
      />
      <section className="policy-profile-create">
        <label>
          {t('modelPolicy.newProfile')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('modelPolicy.newProfilePlaceholder')}
          />
        </label>
        <button type="button" className="button secondary" disabled={!name.trim()} onClick={add}>
          <Plus size={14} />
          {t('modelPolicy.createProfile')}
        </button>
      </section>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {Object.entries(profiles).map(([id, chain]) => (
        <article className="policy-profile" key={id}>
          <header>
            <div>
              <span className="eyebrow">{t('modelPolicy.profileEyebrow')}</span>
              <h3>{id}</h3>
            </div>
            <button
              type="button"
              className="button secondary small"
              onClick={() => change('fallbackModels', Array.isArray(chain) ? [...chain] : [])}
            >
              {t('modelPolicy.useDefault')}
            </button>
            <button
              type="button"
              className="icon-button danger"
              disabled={refs(id)}
              title={
                refs(id) ? t('modelPolicy.removeBlocked') : t('modelPolicy.removeProfileTitle')
              }
              aria-label={t('modelPolicy.removeProfile', { id })}
              onClick={() => change('fallbackProfiles', withoutSetting(profiles, id))}
            >
              <Trash2 size={15} />
            </button>
          </header>
          <OrderedModelChain
            label={t('modelPolicy.profileChain', { id })}
            value={chain}
            onChange={(v) => change('fallbackProfiles', { ...profiles, [id]: v })}
          />
          {refs(id) && <p className="field-help">{t('modelPolicy.usedBy')}</p>}
        </article>
      ))}
    </div>
  );
}
export function modelRef(entry: Row) {
  return entry['provider']
    ? String(entry['provider']) + '/' + String(entry['model'] ?? '')
    : String(entry['model'] ?? '');
}
export function modelRefPatch(entry: Row, value: string): Row {
  const next = { ...entry };
  delete next['provider'];
  delete next['model'];
  const trimmed = value.trim(),
    slash = trimmed.indexOf('/');
  if (trimmed) {
    if (slash > 0) {
      next['provider'] = trimmed.slice(0, slash);
      next['model'] = trimmed.slice(slash + 1);
    } else next['model'] = trimmed;
  }
  return next;
}
export function ProfileSelect({
  label,
  name,
  value,
  profiles,
  onChange,
}: {
  label: string;
  name?: string;
  value: unknown;
  profiles: Row;
  onChange: (v: string) => void;
}) {
  const { t } = useDesktopText();
  const selected = typeof value === 'string' ? value : '';
  return (
    <label>
      {label}
      <select
        aria-label={name ?? label}
        value={selected}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('modelPolicy.inherit')}</option>
        {[...new Set([...Object.keys(profiles), ...(selected ? [selected] : [])])].map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}
export function RoutingPolicySettings({ draft, change, command }: PolicyProps) {
  const { t } = useDesktopText();
  const routes = record(draft['modelMatrix']),
    profiles = record(draft['fallbackProfiles']);
  const [name, setName] = useState(''),
    [error, setError] = useState('');
  const update = (id: string, entry: Row) => change('modelMatrix', { ...routes, [id]: entry });
  const optional = (entry: Row, key: string, value: string) =>
    value ? { ...entry, [key]: value } : withoutSetting(entry, key);
  const reasoning = (id: string, key: string, value: string) => {
    const entry = record(routes[id]),
      runtime = record(entry['modelRuntime']),
      current = record(runtime['reasoning']);
    const next = value
      ? { ...current, [key]: key === 'preserve' ? value === 'true' : value }
      : withoutSetting(current, key);
    update(id, { ...entry, modelRuntime: { ...runtime, reasoning: next } });
  };
  const add = () => {
    const id = name.trim();
    if (!validSettingsName(id) || Object.hasOwn(routes, id)) {
      setError(t('modelPolicy.uniqueRoute'));
      return;
    }
    update(id, { modelRuntime: { reasoning: { mode: 'auto' } } });
    setName('');
    setError('');
  };
  return (
    <div className="model-policy-settings">
      <ModelCatalog command={command} />
      <p className="settings-defaults-note">{t('modelPolicy.routingIntro')}</p>
      <section className="policy-profile-create">
        <label>
          {t('modelPolicy.newRoute')}
          <input
            list="desktop-route-phases"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('modelPolicy.newRoutePlaceholder')}
          />
        </label>
        <datalist id="desktop-route-phases">
          {[
            '*',
            'discovery',
            'planning',
            'build',
            'verify',
            'review',
            'domain',
            'knowledge',
            'delivery',
            'meta',
          ].map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button type="button" className="button secondary" disabled={!name.trim()} onClick={add}>
          <Plus size={14} />
          {t('modelPolicy.addRoute')}
        </button>
      </section>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {!Object.keys(routes).length && <p className="quiet-state">{t('modelPolicy.noRoutes')}</p>}
      {Object.entries(routes).map(([id, value]) => {
        const entry = record(value),
          r = record(record(entry['modelRuntime'])['reasoning']);
        return (
          <article className="policy-profile" key={id}>
            <header>
              <div>
                <span className="eyebrow">
                  {id === '*' ? t('modelPolicy.allAgents') : t('modelPolicy.rolePhase')}
                </span>
                <h3>{id}</h3>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={t('modelPolicy.removeRoute', { id })}
                onClick={() => change('modelMatrix', withoutSetting(routes, id))}
              >
                <Trash2 size={15} />
              </button>
            </header>
            <div className="policy-field-grid">
              <ModelReference
                label={t('modelPolicy.routeModel', { id })}
                value={modelRef(entry)}
                onChange={(v) => update(id, modelRefPatch(entry, v))}
              />
              <ProfileSelect
                label={t('modelPolicy.routeFallback', { id })}
                value={entry['fallbackProfile']}
                profiles={profiles}
                onChange={(v) => update(id, optional(entry, 'fallbackProfile', v))}
              />
            </div>
            <div className="policy-field-grid">
              <label>
                {t('modelPolicy.reasoning', { id })}
                <select
                  aria-label={t('modelPolicy.reasoning', { id })}
                  value={String(r['mode'] ?? '')}
                  onChange={(e) => reasoning(id, 'mode', e.target.value)}
                >
                  {['', 'auto', 'on', 'off'].map((v) => (
                    <option key={v} value={v}>
                      {v || t('modelPolicy.inherit')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('modelPolicy.effort', { id })}
                <select
                  aria-label={t('modelPolicy.effort', { id })}
                  value={String(r['effort'] ?? '')}
                  onChange={(e) => reasoning(id, 'effort', e.target.value)}
                >
                  {['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                    <option key={v} value={v}>
                      {v || t('modelPolicy.inherit')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('modelPolicy.preserve', { id })}
                <select
                  aria-label={t('modelPolicy.preserve', { id })}
                  value={r['preserve'] === undefined ? '' : String(r['preserve'])}
                  onChange={(e) => reasoning(id, 'preserve', e.target.value)}
                >
                  <option value="">{t('modelPolicy.inherit')}</option>
                  <option value="true">{t('modelPolicy.preserveYes')}</option>
                  <option value="false">{t('modelPolicy.preserveNo')}</option>
                </select>
              </label>
            </div>
          </article>
        );
      })}
    </div>
  );
}
