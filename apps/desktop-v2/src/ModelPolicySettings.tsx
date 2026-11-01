import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
            setError(
              'Some model catalogs could not be loaded. Stored model references remain editable.',
            );
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [command]);
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
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
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
        aria-label={label}
        list={catalog}
        value={value}
        placeholder="provider/model · or inherit"
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
        <span>{chain.length} models · tried in order</span>
      </header>
      {chain.map((model, i) => (
        <div className="policy-chain-row" key={i}>
          <span className="policy-order">{i + 1}</span>
          <ModelReference
            label={label + ' model ' + (i + 1)}
            value={model}
            onChange={(v) => onChange(chain.map((old, n) => (n === i ? v : old)))}
          />
          <button
            type="button"
            className="icon-button"
            disabled={i === 0}
            aria-label={'Move ' + label + ' model ' + (i + 1) + ' up'}
            onClick={() => move(i, -1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={i === chain.length - 1}
            aria-label={'Move ' + label + ' model ' + (i + 1) + ' down'}
            onClick={() => move(i, 1)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button danger"
            aria-label={'Remove ' + label + ' model ' + (i + 1)}
            onClick={() => onChange(chain.filter((_, n) => n !== i))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!chain.length && <p className="field-help">No fallback models configured.</p>}
      <button
        type="button"
        className="button secondary small"
        onClick={() => onChange([...chain, ''])}
      >
        <Plus size={13} />
        Add model
      </button>
    </section>
  );
}
export function FallbackPolicySettings({ draft, change, command }: PolicyProps) {
  const profiles = record(draft['fallbackProfiles']);
  const [name, setName] = useState(''),
    [error, setError] = useState('');
  const add = () => {
    const id = name.trim();
    if (!validSettingsName(id) || Object.hasOwn(profiles, id)) {
      setError('Choose a unique profile name.');
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
      <p className="settings-defaults-note">
        The first available model wins. Named profiles can be selected by task assignments, routing
        rules and cost tiers.
      </p>
      <OrderedModelChain
        label="Default fallback chain"
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
          New fallback profile
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. daily-build"
          />
        </label>
        <button type="button" className="button secondary" disabled={!name.trim()} onClick={add}>
          <Plus size={14} />
          Create profile
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
              <span className="eyebrow">NAMED PROFILE</span>
              <h3>{id}</h3>
            </div>
            <button
              type="button"
              className="button secondary small"
              onClick={() => change('fallbackModels', Array.isArray(chain) ? [...chain] : [])}
            >
              Use as default chain
            </button>
            <button
              type="button"
              className="icon-button danger"
              disabled={refs(id)}
              title={
                refs(id)
                  ? 'Remove refiner, review, routing and tier references before deleting this profile'
                  : 'Remove profile from this draft'
              }
              aria-label={'Remove profile ' + id}
              onClick={() => change('fallbackProfiles', withoutSetting(profiles, id))}
            >
              <Trash2 size={15} />
            </button>
          </header>
          <OrderedModelChain
            label={id + ' chain'}
            value={chain}
            onChange={(v) => change('fallbackProfiles', { ...profiles, [id]: v })}
          />
          {refs(id) && (
            <p className="field-help">Used by refinement, review, routing or a cost tier.</p>
          )}
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
  value,
  profiles,
  onChange,
}: {
  label: string;
  value: unknown;
  profiles: Row;
  onChange: (v: string) => void;
}) {
  const selected = typeof value === 'string' ? value : '';
  return (
    <label>
      {label}
      <select aria-label={label} value={selected} onChange={(e) => onChange(e.target.value)}>
        <option value="">Inherit</option>
        {[...new Set([...Object.keys(profiles), ...(selected ? [selected] : [])])].map((id) => (
          <option key={id}>{id}</option>
        ))}
      </select>
    </label>
  );
}
export function RoutingPolicySettings({ draft, change, command }: PolicyProps) {
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
      setError('Choose a unique phase, role, or wildcard route.');
      return;
    }
    update(id, { modelRuntime: { reasoning: { mode: 'auto' } } });
    setName('');
    setError('');
  };
  return (
    <div className="model-policy-settings">
      <ModelCatalog command={command} />
      <p className="settings-defaults-note">
        Exact role → phase → wildcard (*) → engine default. Each rule can override its model,
        fallback profile and reasoning while preserving other runtime settings.
      </p>
      <section className="policy-profile-create">
        <label>
          New model route
          <input
            list="desktop-route-phases"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="architect, build, or *"
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
          Add route
        </button>
      </section>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {!Object.keys(routes).length && (
        <p className="quiet-state">No overrides. Agents inherit the engine’s configured model.</p>
      )}
      {Object.entries(routes).map(([id, value]) => {
        const entry = record(value),
          r = record(record(entry['modelRuntime'])['reasoning']);
        return (
          <article className="policy-profile" key={id}>
            <header>
              <div>
                <span className="eyebrow">{id === '*' ? 'ALL AGENTS' : 'ROLE / PHASE'}</span>
                <h3>{id}</h3>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={'Remove route ' + id}
                onClick={() => change('modelMatrix', withoutSetting(routes, id))}
              >
                <Trash2 size={15} />
              </button>
            </header>
            <div className="policy-field-grid">
              <ModelReference
                label={id + ' model'}
                value={modelRef(entry)}
                onChange={(v) => update(id, modelRefPatch(entry, v))}
              />
              <ProfileSelect
                label={id + ' fallback profile'}
                value={entry['fallbackProfile']}
                profiles={profiles}
                onChange={(v) => update(id, optional(entry, 'fallbackProfile', v))}
              />
            </div>
            <div className="policy-field-grid">
              <label>
                {id} reasoning
                <select
                  aria-label={id + ' reasoning'}
                  value={String(r['mode'] ?? '')}
                  onChange={(e) => reasoning(id, 'mode', e.target.value)}
                >
                  {['', 'auto', 'on', 'off'].map((v) => (
                    <option key={v} value={v}>
                      {v || 'Inherit'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {id} effort
                <select
                  aria-label={id + ' effort'}
                  value={String(r['effort'] ?? '')}
                  onChange={(e) => reasoning(id, 'effort', e.target.value)}
                >
                  {['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                    <option key={v} value={v}>
                      {v || 'Inherit'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {id} preserve reasoning
                <select
                  aria-label={id + ' preserve reasoning'}
                  value={r['preserve'] === undefined ? '' : String(r['preserve'])}
                  onChange={(e) => reasoning(id, 'preserve', e.target.value)}
                >
                  <option value="">Inherit</option>
                  <option value="true">Preserve</option>
                  <option value="false">Do not preserve</option>
                </select>
              </label>
            </div>
          </article>
        );
      })}
    </div>
  );
}
