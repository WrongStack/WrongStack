import { ArrowDown, ArrowUp, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { localizedText, useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { emptyEngineState } from './engine-state';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import { rosterRuntimeDraft } from './roster-document-store';
import {
  mergeRosterConfig,
  type RosterRecord,
  rosterBudgetFields,
  rosterConfig,
  rosterDocumentKey,
} from './roster-model';
import { sameSetting } from './settings-save-model';
import { TimeZoneInput } from './TimeZoneInput';

const drafts = new Map<string, { base: RosterRecord; draft: RosterRecord }>();
const text = (value: unknown) => (typeof value === 'string' ? value : '');
export function RosterRuntimeEditor({
  projectId,
  role,
  snapshot,
  effective,
  toolNames,
  skillNames,
  command,
  onClose,
  onSaved,
}: {
  projectId: string;
  role: string;
  snapshot: RosterRecord;
  effective: RosterRecord;
  toolNames: string[];
  skillNames: string[];
  command: EngineCommand;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useDesktopText();
  const key = rosterDocumentKey(projectId, role, 'runtime');
  const cached = useRef(drafts.get(key)).current;
  const [base, setBase] = useState(cached?.base ?? record(snapshot['config']));
  const [draft, setDraft] = useState<RosterRecord>(
    cached?.draft ?? structuredClone(record(snapshot['config'])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [picker, setPicker] = useState<'model' | 'allowed' | null>(null),
    [pickerBusy, setPickerBusy] = useState(false);
  const saving = useRef(false);
  const durable = useMemo(() => rosterRuntimeDraft(projectId, role), [projectId, role]);
  const durableState = useSyncExternalStore(durable.subscribe, durable.snapshot);
  const [recovered, setRecovered] = useState(false);
  // Without an in-window draft the editor reads the store itself: the parent snapshot can
  // still predate a save made a moment ago, and a stale base would turn into a false conflict.
  const [fresh, setFresh] = useState(!!cached);
  useEffect(() => {
    if (cached) return;
    let active = true;
    void (async () => {
      try {
        await durable.load();
        const parked = durable.snapshot().value;
        if (!active) return;
        if (parked) {
          // The save merge still compares this baseline with the current store.
          setBase(parked.base);
          setDraft(parked.draft);
          drafts.set(key, parked);
          setRecovered(true);
          return;
        }
        const current = await command(
          'agent-roster.read-customization',
          { role, includeDocuments: false },
          ['agent-roster.read-customization'],
        );
        if (!active || current['configState'] === 'unreadable') return;
        const config = record(current['config']);
        setBase(config);
        setDraft(structuredClone(config));
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setFresh(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [cached, durable, key, command, role]);
  // Drops the in-window copy and the device copy together.
  const forget = () => {
    drafts.delete(key);
    if (durable.snapshot().ready && durable.snapshot().value) durable.edit(null);
  };
  const dirty = !sameSetting(draft, base);
  const change = (next: RosterRecord) => {
    setDraft(next);
    drafts.set(key, { base, draft: next });
    if (durable.snapshot().ready)
      durable.edit(sameSetting(next, base) ? null : { base, draft: next });
    setError('');
  };
  const field = (name: string, value: unknown) => {
    const next = { ...draft };
    if (value === undefined) delete next[name];
    else next[name] = value;
    change(next);
  };
  const close = () => {
    if (busy) return;
    if (dirty) setLeaving(true);
    else onClose();
  };
  const budget = record(draft['budget']),
    policy = record(draft['modelPolicy']),
    available = record(draft['availability']);
  const allowed = entries(policy['allowed']),
    fallbacks = entries(policy['fallbacks']);
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await command(
        'agent-roster.read-customization',
        { role, includeDocuments: false },
        ['agent-roster.read-customization'],
      );
      if (current['configState'] === 'unreadable') throw Error(t('rosterEdit.unreadable'));
      if (snapshot['profile'] && !current['profile']) throw Error(t('rosterEdit.removed'));
      const next = mergeRosterConfig(base, draft, record(current['config']));
      await command('agent-roster.update-config', { role, config: next }, [
        'agent-roster.update-config',
      ]);
      const actual = await command(
        'agent-roster.read-customization',
        { role, includeDocuments: false },
        ['agent-roster.read-customization'],
      );
      if (actual['configState'] === 'unreadable' || !sameSetting(actual['config'], next))
        throw Error(t('rosterEdit.mismatch'));
      forget();
      setBase(next);
      setDraft(next);
      onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const modelPolicy = (next: RosterRecord) => field('modelPolicy', next);
  const capabilityChoices = Array.isArray(effective['allowedCapabilities'])
    ? effective['allowedCapabilities'].map(String)
    : [];
  return (
    <>
      <Modal title={t('rosterEdit.modalTitle', { role })} onClose={close}>
        <div className="roster-runtime-editor">
          <header>
            <div>
              <span className="eyebrow">{t('rosterEdit.eyebrow', { role })}</span>
              <h2>{t('rosterEdit.title')}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('rosterEdit.close')}
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          <p>{t('rosterEdit.intro')}</p>
          {snapshot['systemProtected'] === true && (
            <p className="roster-policy-note">{t('rosterEdit.builtinNote')}</p>
          )}
          {(cached || recovered) && dirty && (
            <p role="status" className="roster-policy-note">
              {t('rosterEdit.recovered')}
            </p>
          )}
          {durableState.error && (
            <p role="alert" className="session-error">
              {durableState.error}
            </p>
          )}
          {durableState.review && (
            <div className="roster-confirm" role="alert">
              <p>{t('rosterEdit.conflict')}</p>
              <button
                type="button"
                className="button secondary"
                onClick={() => void durable.resolve('local')}
              >
                {t('rosterEdit.keepWindow')}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const saved = durableState.review?.value;
                  void durable.resolve('saved').then((ok) => {
                    if (ok && saved) {
                      setBase(saved.base);
                      setDraft(saved.draft);
                    }
                  });
                }}
              >
                {t('rosterEdit.useSaved')}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="session-error">
              {localizedText(error, 'settingsMessage', t)}
            </p>
          )}
          <fieldset disabled={busy || !fresh}>
            <section>
              <h3>{t('rosterEdit.modelSection')}</h3>
              <div className="roster-form-grid">
                <div>
                  <span className="field-label">{t('rosterEdit.roleModel')}</span>
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={t('rosterEdit.chooseModel')}
                    onClick={() => setPicker('model')}
                  >
                    {draft['provider'] || draft['model']
                      ? `${draft['provider'] ?? '*'}/${draft['model'] ?? '*'}`
                      : t('rosterEdit.inheritRouting')}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      const next = { ...draft };
                      delete next['provider'];
                      delete next['model'];
                      change(next);
                    }}
                  >
                    {t('rosterEdit.inheritModel')}
                  </button>
                </div>
                <label>
                  {t('rosterEdit.fallbackProfile')}
                  <input
                    aria-label={t('rosterEdit.fallbackLabel')}
                    value={text(draft['fallbackProfile'])}
                    disabled={!!draft['modelPolicy']}
                    onChange={(event) => field('fallbackProfile', event.target.value || undefined)}
                    placeholder={t('rosterEdit.inherit')}
                  />
                  <small>{t('rosterEdit.fallbackHelp')}</small>
                </label>
                <label>
                  {t('rosterEdit.cwd')}
                  <input
                    aria-label={t('rosterEdit.cwdLabel')}
                    value={text(draft['cwd'])}
                    onChange={(event) => field('cwd', event.target.value || undefined)}
                    placeholder={t('rosterEdit.cwdPlaceholder')}
                  />
                </label>
                <label>
                  {t('rosterEdit.checkoutTitle')}
                  <select
                    aria-label={t('rosterEdit.checkoutLabel')}
                    value={draft['worktree'] === undefined ? '' : String(draft['worktree'])}
                    onChange={(event) =>
                      field(
                        'worktree',
                        event.target.value === ''
                          ? undefined
                          : event.target.value === 'true'
                            ? true
                            : event.target.value === 'false'
                              ? false
                              : event.target.value,
                      )
                    }
                  >
                    <option value="">{t('rosterEdit.inherit')}</option>
                    <option value="auto">{t('rosterEdit.checkout.auto')}</option>
                    <option value="required">{t('rosterEdit.checkout.required')}</option>
                    <option value="off">{t('rosterEdit.checkout.off')}</option>
                    <option value="true">{t('rosterEdit.checkout.true')}</option>
                    <option value="false">{t('rosterEdit.checkout.false')}</option>
                  </select>
                </label>
              </div>
            </section>
            <section>
              <h3>{t('rosterEdit.budgets')}</h3>
              <p className="field-help">{t('rosterEdit.budgetsHelp')}</p>
              <div className="roster-form-grid">
                {rosterBudgetFields.map(({ key: fieldKey, label: english }) => {
                  const label = t(`roster.budget.${fieldKey}`, { defaultValue: english });
                  return (
                    <label key={fieldKey}>
                      {label}
                      <input
                        aria-label={t('rosterEdit.budgetLabel', { field: label })}
                        inputMode={fieldKey === 'maxCostUsd' ? 'decimal' : 'numeric'}
                        value={budget[fieldKey] === undefined ? '' : String(budget[fieldKey])}
                        onChange={(event) =>
                          field('budget', { ...budget, [fieldKey]: event.target.value })
                        }
                        placeholder={t('rosterEdit.inherit')}
                      />
                      <small>
                        {t('rosterEdit.resolved', {
                          value:
                            record(effective['budget'])[fieldKey] === undefined
                              ? t('roster.notReported')
                              : String(record(effective['budget'])[fieldKey]),
                        })}
                      </small>
                    </label>
                  );
                })}
              </div>
            </section>
            <section>
              <h3>{t('rosterEdit.policy')}</h3>
              <label className="roster-checkbox">
                <input
                  type="checkbox"
                  checked={!!draft['modelPolicy']}
                  onChange={(event) =>
                    event.target.checked
                      ? modelPolicy({ allowed: [], fallbacks: [], strict: false })
                      : field('modelPolicy', undefined)
                  }
                />
                {t('rosterEdit.usePolicy')}
              </label>
              {draft['modelPolicy'] !== undefined && (
                <>
                  <label className="roster-checkbox">
                    <input
                      type="checkbox"
                      checked={policy['strict'] === true}
                      onChange={(event) => modelPolicy({ ...policy, strict: event.target.checked })}
                    />
                    {t('rosterEdit.enforce')}
                  </label>
                  <p className="field-help">{t('rosterEdit.policyHelp')}</p>
                  <div className="roster-model-targets">
                    {allowed.map((target, index) => (
                      <div key={`${target['provider']}/${target['model']}`}>
                        <code>
                          {String(target['provider'])}/{String(target['model'])}
                        </code>
                        <label className="roster-checkbox">
                          <input
                            type="checkbox"
                            checked={fallbacks.some((item) => sameSetting(item, target))}
                            onChange={(event) =>
                              modelPolicy({
                                ...policy,
                                fallbacks: event.target.checked
                                  ? [...fallbacks, target]
                                  : fallbacks.filter((item) => !sameSetting(item, target)),
                              })
                            }
                          />
                          {t('rosterEdit.fallback')}
                        </label>
                        <button
                          type="button"
                          className="icon-button danger"
                          aria-label={t('rosterEdit.removeAllowed', { n: index + 1 })}
                          onClick={() =>
                            modelPolicy({
                              ...policy,
                              allowed: allowed.filter((_, i) => i !== index),
                              fallbacks: fallbacks.filter((item) => !sameSetting(item, target)),
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setPicker('allowed')}
                  >
                    <Plus size={14} />
                    {t('rosterEdit.addAllowed')}
                  </button>
                  {fallbacks.length > 0 && (
                    <ol className="roster-model-targets">
                      {fallbacks.map((target, index) => (
                        <li key={`${target['provider']}/${target['model']}`}>
                          <code>
                            {String(target['provider'])}/{String(target['model'])}
                          </code>
                          {[-1, 1].map((direction) => (
                            <button
                              key={direction}
                              type="button"
                              className="icon-button"
                              aria-label={t(
                                direction < 0 ? 'rosterEdit.moveUp' : 'rosterEdit.moveDown',
                                {
                                  n: index + 1,
                                },
                              )}
                              disabled={
                                index + direction < 0 || index + direction >= fallbacks.length
                              }
                              onClick={() => {
                                const next = [...fallbacks];
                                [next[index], next[index + direction]] = [
                                  next[index + direction]!,
                                  next[index]!,
                                ];
                                modelPolicy({ ...policy, fallbacks: next });
                              }}
                            >
                              {direction < 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                            </button>
                          ))}
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </section>
            <section>
              <h3>{t('rosterEdit.availability')}</h3>
              <label className="roster-checkbox">
                <input
                  type="checkbox"
                  checked={!!draft['availability']}
                  onChange={(event) =>
                    field(
                      'availability',
                      event.target.checked
                        ? {
                            timezone: 'UTC',
                            days: [1, 2, 3, 4, 5],
                            start: '09:00',
                            end: '17:00',
                            mode: 'advisory',
                          }
                        : undefined,
                    )
                  }
                />
                {t('rosterEdit.setWindow')}
              </label>
              {draft['availability'] !== undefined && (
                <>
                  <div className="roster-form-grid">
                    <TimeZoneInput
                      label={t('rosterEdit.timezone')}
                      aria-label={t('rosterEdit.timezoneLabel')}
                      value={text(available['timezone'])}
                      onChange={(event) =>
                        field('availability', { ...available, timezone: event.target.value })
                      }
                      placeholder="Europe/Kyiv"
                    />
                    <label>
                      {t('rosterEdit.policyLabel')}
                      <select
                        aria-label={t('rosterEdit.policySelect')}
                        value={text(available['mode']) || 'advisory'}
                        onChange={(event) =>
                          field('availability', { ...available, mode: event.target.value })
                        }
                      >
                        <option value="advisory">{t('rosterEdit.advisory')}</option>
                        <option value="enforce">{t('rosterEdit.enforceCustom')}</option>
                      </select>
                    </label>
                    {(['start', 'end'] as const).map((name) => (
                      <label key={name}>
                        {name === 'start' ? t('rosterEdit.from') : t('rosterEdit.until')}
                        <input
                          aria-label={t(`rosterEdit.timeLabel.${name}`)}
                          type="time"
                          value={text(available[name])}
                          onChange={(event) =>
                            field('availability', { ...available, [name]: event.target.value })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="roster-weekdays">
                    {[0, 1, 2, 3, 4, 5, 6].map((index) => {
                      const day = t(`roster.day.${index}`);
                      return (
                        <label key={day}>
                          <input
                            type="checkbox"
                            aria-label={t('rosterEdit.dayLabel', { day })}
                            checked={
                              Array.isArray(available['days']) && available['days'].includes(index)
                            }
                            onChange={(event) => {
                              const days = Array.isArray(available['days'])
                                ? available['days']
                                : [];
                              field('availability', {
                                ...available,
                                days: event.target.checked
                                  ? [...days, index].sort()
                                  : days.filter((day) => day !== index),
                              });
                            }}
                          />
                          {day}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
            <RosterListOverride
              kind="tools"
              value={draft['tools']}
              choices={toolNames}
              onChange={(value) => field('tools', value)}
            />
            <RosterListOverride
              kind="skills"
              value={draft['skillNames']}
              choices={skillNames}
              onChange={(value) => field('skillNames', value)}
            />
            <RosterListOverride
              kind="capabilities"
              value={draft['allowedCapabilities']}
              choices={capabilityChoices}
              onChange={(value) => field('allowedCapabilities', value)}
            />
          </fieldset>
          {leaving && (
            <div className="roster-confirm" role="alert">
              <p>{t('rosterEdit.unsaved')}</p>
              <button type="button" className="button secondary" onClick={() => setLeaving(false)}>
                {t('rosterEdit.keepEditing')}
              </button>
              <button type="button" className="button secondary" onClick={onClose}>
                {t('rosterEdit.keepClose')}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  forget();
                  onClose();
                }}
              >
                {t('rosterEdit.discard')}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const current = await command(
                      'agent-roster.read-customization',
                      { role, includeDocuments: false },
                      ['agent-roster.read-customization'],
                    );
                    if (current['configState'] === 'unreadable')
                      throw Error(t('rosterEdit.configUnreadable'));
                    const config = record(current['config']);
                    setBase(config);
                    setDraft(structuredClone(config));
                    forget();
                    setLeaving(false);
                    setError('');
                  } catch (error) {
                    setError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('rosterEdit.reload')}
              </button>
            </div>
          )}
          <footer>
            <span role="status">
              {!fresh
                ? t('rosterEdit.reading')
                : dirty
                  ? t('rosterEdit.dirty')
                  : t('rosterEdit.loaded')}
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => (dirty ? setLeaving(true) : onClose())}
            >
              {t('rosterEdit.close2')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!dirty || busy || !fresh}
              onClick={() => {
                try {
                  rosterConfig(draft);
                  void save();
                } catch (error) {
                  setError(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              <Save size={14} />
              {t('rosterEdit.save')}
            </button>
          </footer>
        </div>
      </Modal>
      {picker && (
        <Modal
          title={t(picker === 'model' ? 'rosterEdit.pickModel' : 'rosterEdit.pickAllowed', {
            role,
          })}
          onClose={() => {
            if (!pickerBusy) setPicker(null);
          }}
        >
          <ProfileModelPicker
            session={{
              ...emptyEngineState,
              provider: text(draft['provider']),
              model: text(draft['model']),
            }}
            title={t(picker === 'model' ? 'rosterEdit.pickModel' : 'rosterEdit.pickAllowed', {
              role,
            })}
            description={t('rosterEdit.pickHelp')}
            onPick={(provider, model) => {
              if (picker === 'model') change({ ...draft, provider, model });
              else {
                const target = { provider, model };
                modelPolicy({
                  ...policy,
                  allowed: allowed.some((entry) => sameSetting(entry, target))
                    ? allowed
                    : [...allowed, target],
                });
              }
            }}
            onClose={() => setPicker(null)}
            onBusy={setPickerBusy}
          />
        </Modal>
      )}
    </>
  );
}

function RosterListOverride({
  kind,
  value,
  choices,
  onChange,
}: {
  kind: 'tools' | 'skills' | 'capabilities';
  value: unknown;
  choices: string[];
  onChange: (value: string[] | undefined) => void;
}) {
  const { t } = useDesktopText();
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(100);
  const selected = Array.isArray(value) ? value.map(String) : [];
  const items = [...new Set([...selected, ...choices])]
    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
    .sort();
  return (
    <section className="roster-list-override">
      <h3>{t(`rosterEdit.list.${kind}`)}</h3>
      <label className="roster-checkbox">
        <input
          type="checkbox"
          checked={Array.isArray(value)}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        {t(`rosterEdit.override.${kind}`)}
      </label>
      <p className="field-help">
        {Array.isArray(value)
          ? t('rosterEdit.explicitNames', { count: selected.length })
          : t('rosterEdit.catalogDefaults')}
      </p>
      {Array.isArray(value) && (
        <>
          <label>
            {t('rosterEdit.findName')}
            <input
              aria-label={t(`rosterEdit.search.${kind}`)}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(100);
              }}
            />
          </label>
          {query.trim() && !items.includes(query.trim()) && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                onChange([...selected, query.trim()]);
                setQuery('');
              }}
            >
              {t('rosterEdit.addName', { name: query.trim() })}
            </button>
          )}
          <div className="roster-grant-options">
            {items.slice(0, limit).map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={selected.includes(name)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, name]
                        : selected.filter((entry) => entry !== name),
                    )
                  }
                />
                <span>{name}</span>
                {!choices.includes(name) && <small>{t('rosterEdit.storedCustom')}</small>}
              </label>
            ))}
          </div>
          {items.length > limit && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => setLimit(limit + 100)}
            >
              {t('rosterEdit.showMore', { count: items.length - limit })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
