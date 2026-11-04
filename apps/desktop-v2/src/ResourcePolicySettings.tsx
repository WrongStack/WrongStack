import {
  formatLimitRange,
  LIMIT_BOUNDS,
  LIMITS_BUDGET_KEYS,
  LIMITS_SCALAR_KEYS,
} from '@wrongstack/contracts/types/config/limits';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import {
  ModelCatalog,
  ModelReference,
  modelRef,
  modelRefPatch,
  type PolicyProps,
  ProfileSelect,
} from './ModelPolicySettings';
import { removeModelTier, validSettingsName, withoutSetting } from './settings-save-model';

type Row = Record<string, unknown>;
export function LimitsPolicySettings({ draft, change }: Pick<PolicyProps, 'draft' | 'change'>) {
  const { t } = useDesktopText();
  const limits = record(draft['limits']),
    budget = record(limits['subagentDefaultBudget']);
  const input = (
    key: (typeof LIMITS_SCALAR_KEYS)[number] | (typeof LIMITS_BUDGET_KEYS)[number],
    worker: boolean,
  ) => {
    const values = worker ? budget : limits,
      value = values[key],
      bound = LIMIT_BOUNDS[key];
    return (
      <div className="setting-row setting-number" key={key}>
        <div>
          <label htmlFor={'limit-' + key}>{t(`limitsPolicy.field.${key}`)}</label>
          <p>{bound.why}</p>
          <small>{formatLimitRange(key)}</small>
        </div>
        <div className="setting-control">
          <input
            id={'limit-' + key}
            type="number"
            min={bound.min}
            max={bound.max}
            step="1"
            value={typeof value === 'number' ? value : ''}
            placeholder={t('limitsPolicy.engineDefault')}
            onChange={(e) => {
              const next =
                e.target.value === ''
                  ? withoutSetting(values, key)
                  : { ...values, [key]: Number(e.target.value) };
              change('limits', worker ? { ...limits, subagentDefaultBudget: next } : next);
            }}
          />
        </div>
      </div>
    );
  };
  return (
    <div className="model-policy-settings">
      <p className="settings-defaults-note">{t('limitsPolicy.intro')}</p>
      <section aria-label={t('limitsPolicy.contextLabel')}>
        <h3>{t('limitsPolicy.contextTitle')}</h3>
        {LIMITS_SCALAR_KEYS.map((key) => input(key, false))}
      </section>
      <section aria-label={t('limitsPolicy.workerTitle')}>
        <h3>{t('limitsPolicy.workerTitle')}</h3>
        <p className="field-help">{t('limitsPolicy.workerHelp')}</p>
        {LIMITS_BUDGET_KEYS.map((key) => input(key, true))}
      </section>
    </div>
  );
}
function OptionalNumber({
  label,
  value,
  min = 0,
  max,
  step = 'any',
  onChange,
}: {
  label: string;
  value: unknown;
  min?: number;
  max?: number;
  step?: string;
  onChange: (v: number | undefined) => void;
}) {
  const { t } = useDesktopText();
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={typeof value === 'number' ? value : ''}
        placeholder={t('tierPolicy.inherit')}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </label>
  );
}
export function TierPolicySettings({ draft, change, command }: PolicyProps) {
  const { t } = useDesktopText();
  const tiers = record(draft['modelTiers']),
    levels = record(tiers['levels']),
    routes = record(tiers['routing']),
    leader = record(tiers['leader']),
    profiles = record(draft['fallbackProfiles']);
  const [name, setName] = useState(''),
    [route, setRoute] = useState(''),
    [target, setTarget] = useState(''),
    [error, setError] = useState('');
  const patch = (values: Row) => change('modelTiers', { ...tiers, ...values });
  const level = (id: string, values: Row) => patch({ levels: { ...levels, [id]: values } });
  const optional = (row: Row, key: string, value: unknown) =>
    value === '' || value === undefined ? withoutSetting(row, key) : { ...row, [key]: value };
  const tierSelect = (label: string, value: unknown, onChange: (v: string) => void) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('tierPolicy.inherit')}</option>
        {[
          ...new Set([
            ...Object.keys(levels),
            ...(typeof value === 'string' && value ? [value] : []),
          ]),
        ].map((id) => (
          <option key={id}>{id}</option>
        ))}
      </select>
    </label>
  );
  const add = () => {
    const id = name.trim();
    if (!validSettingsName(id) || Object.hasOwn(levels, id)) {
      setError(t('tierPolicy.uniqueName'));
      return;
    }
    level(id, {});
    setName('');
    setError('');
  };
  return (
    <div className="model-policy-settings">
      <ModelCatalog command={command} />
      <p className="settings-defaults-note">{t('tierPolicy.intro')}</p>
      <label className="policy-toggle">
        <input
          type="checkbox"
          checked={tiers['enabled'] === true}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        {t('tierPolicy.enable')}
      </label>
      {tierSelect(t('tierPolicy.default'), tiers['default'], (v) =>
        change('modelTiers', optional(tiers, 'default', v)),
      )}
      <section className="policy-profile-create">
        <label>
          {t('tierPolicy.newTier')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tierPolicy.newTierPlaceholder')}
          />
        </label>
        <button type="button" className="button secondary" disabled={!name.trim()} onClick={add}>
          <Plus size={14} />
          {t('tierPolicy.add')}
        </button>
      </section>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {Object.entries(levels).map(([id, v]) => {
        const row = record(v);
        return (
          <article className="policy-profile" key={id}>
            <header>
              <div>
                <span className="eyebrow">{t('tierPolicy.eyebrow')}</span>
                <h3>{id}</h3>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={t('tierPolicy.remove', { id })}
                onClick={() => change('modelTiers', removeModelTier(tiers, id))}
              >
                <Trash2 size={15} />
              </button>
            </header>
            <label>
              {t('tierPolicy.description', { id })}
              <input
                value={String(row['description'] ?? '')}
                onChange={(e) => level(id, optional(row, 'description', e.target.value))}
              />
            </label>
            <div className="policy-field-grid">
              <ModelReference
                label={t('tierPolicy.primary', { id })}
                value={modelRef(row)}
                onChange={(v) => level(id, modelRefPatch(row, v))}
              />
              <ProfileSelect
                label={t('tierPolicy.fallback', { id })}
                value={row['fallbackProfile']}
                profiles={profiles}
                onChange={(v) => level(id, optional(row, 'fallbackProfile', v))}
              />
            </div>
            <div className="policy-field-grid">
              {(
                [
                  ['maxCostUsd', 0, '0.01'],
                  ['maxIterations', 1, '1'],
                  ['maxToolCalls', 1, '1'],
                  ['maxTokens', 1, '1'],
                  ['timeoutMs', 1, '1'],
                ] as const
              ).map(([key, min, step]) => (
                <OptionalNumber
                  key={key}
                  label={t('tierPolicy.budget', {
                    id,
                    label: t(`tierPolicy.budgetField.${key}`),
                  })}
                  value={row[key]}
                  min={min}
                  step={step}
                  onChange={(v) => level(id, optional(row, key, v))}
                />
              ))}
            </div>
          </article>
        );
      })}
      <section className="policy-profile">
        <header>
          <div>
            <span className="eyebrow">{t('tierPolicy.routingEyebrow')}</span>
            <h3>{t('tierPolicy.routingTitle')}</h3>
          </div>
        </header>
        {Object.entries(routes).map(([id, value]) => (
          <div className="policy-chain-row" key={id}>
            {tierSelect(t('tierPolicy.routeTier', { id }), value, (v) =>
              patch({ routing: v ? { ...routes, [id]: v } : withoutSetting(routes, id) }),
            )}
            <button
              type="button"
              className="icon-button danger"
              aria-label={t('tierPolicy.removeRoute', { id })}
              onClick={() => patch({ routing: withoutSetting(routes, id) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="policy-field-grid">
          <label>
            {t('tierPolicy.routeName')}
            <input
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              placeholder={t('tierPolicy.routeNamePlaceholder')}
            />
          </label>
          {tierSelect(t('tierPolicy.routeTo'), target, setTarget)}
          <button
            type="button"
            className="button secondary"
            disabled={!validSettingsName(route) || !target || Object.hasOwn(routes, route.trim())}
            onClick={() => {
              patch({ routing: { ...routes, [route.trim()]: target } });
              setRoute('');
              setTarget('');
            }}
          >
            {t('tierPolicy.addRoute')}
          </button>
        </div>
      </section>
      <section className="policy-profile">
        <header>
          <div>
            <span className="eyebrow">{t('tierPolicy.leaderEyebrow')}</span>
            <h3>{t('tierPolicy.leaderTitle')}</h3>
          </div>
        </header>
        <p className="field-help">{t('tierPolicy.leaderIntro')}</p>
        <label>
          {t('tierPolicy.leaderMode')}
          <select
            aria-label={t('tierPolicy.leaderMode')}
            value={String(leader['mode'] ?? 'off')}
            onChange={(e) => patch({ leader: { ...leader, mode: e.target.value } })}
          >
            {['off', 'propose', 'auto'].map((v) => (
              <option key={v} value={v}>
                {t(`tierPolicy.leaderModeOption.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="policy-field-grid">
          {tierSelect(t('tierPolicy.leaderMax'), leader['maxTier'], (v) =>
            patch({ leader: optional(leader, 'maxTier', v) }),
          )}
          <OptionalNumber
            label={t('tierPolicy.dwell')}
            value={leader['dwellTurns']}
            min={0}
            step="1"
            onChange={(v) => patch({ leader: optional(leader, 'dwellTurns', v) })}
          />
          <OptionalNumber
            label={t('tierPolicy.savings')}
            value={leader['minSavingsUsd']}
            min={0}
            onChange={(v) => patch({ leader: optional(leader, 'minSavingsUsd', v) })}
          />
          <OptionalNumber
            label={t('tierPolicy.contextFill')}
            value={leader['maxContextFillForSwitch']}
            min={0}
            max={1}
            onChange={(v) => patch({ leader: optional(leader, 'maxContextFillForSwitch', v) })}
          />
        </div>
      </section>
    </div>
  );
}
