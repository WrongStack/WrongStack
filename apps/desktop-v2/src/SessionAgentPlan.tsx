import { Check, LoaderCircle, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { effortNames } from './composer-model';
import { useDesktopText } from './desktop-i18n';
import type { FormDraftStorage } from './durable-form-draft';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { record } from './engine-values';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import {
  type AgentModelPlan,
  agentModelPlan,
  agentPlanPatch,
  agentRouteTarget,
  resizeAgentLanes,
} from './session-agent-plan';
import { sameSetting } from './settings-save-model';
import { AgentPlanDraftStatus, useAgentPlanDraft } from './useAgentPlanDraft';
import './session-agent-plan.css';

type Route = Record<string, unknown>;
export function SessionAgentPlan({
  state,
  command,
  onClose,
  draftStorage,
}: {
  state: EngineState;
  command: EngineCommand;
  onClose: () => void;
  /** Native storage for unsaved edits of this session's plan. */
  draftStorage?: FormDraftStorage;
}) {
  const { t } = useDesktopText();
  const [base, setBase] = useState<unknown>(undefined);
  const [plan, setPlan] = useState<AgentModelPlan | null>(null);
  const [prefs, setPrefs] = useState<Route>({});
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [role, setRole] = useState(''),
    [discard, setDiscard] = useState(false);
  const [resize, setResize] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ index?: number; role?: string } | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const live = useRef(true);
  const readSequence = useRef(0);
  const original = useRef<AgentModelPlan | null>(null);
  const dirty = !!plan && !sameSetting(plan, original.current);
  const catalogId = useId();
  const applyDraft = useCallback((next: AgentModelPlan, message: string) => {
    setPlan(next);
    setNotice(message);
  }, []);
  const saved = useAgentPlanDraft({
    storage: draftStorage,
    loaded,
    base,
    plan,
    dirty,
    apply: applyDraft,
  });
  const load = useCallback(async () => {
    const version = ++readSequence.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const snapshot = await command('prefs.get', {}, ['prefs.updated']);
      if (!live.current || readSequence.current !== version) return;
      const parsed = agentModelPlan(snapshot['subagentModelPlan']);
      setBase(snapshot['subagentModelPlan']);
      setPlan(parsed);
      original.current = parsed;
      setPrefs(snapshot);
      setLoaded(true);
      setDiscard(false);
    } catch (error) {
      if (live.current && readSequence.current === version)
        setError(String(error instanceof Error ? error.message : error));
    } finally {
      if (live.current && readSequence.current === version) setBusy(false);
    }
  }, [command]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      readSequence.current++;
    };
  }, [load]);
  const close = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const change = (next: AgentModelPlan) => {
    setPlan(next);
    setNotice('');
    setError('');
  };
  const updateRoute = (target: { index?: number; role?: string }, next: Route) => {
    if (!plan) return;
    if (target.role !== undefined)
      change({ ...plan, roles: { ...plan.roles, [target.role]: next } });
    else
      change({
        ...plan,
        slots: plan.slots.map((slot, index) => (index === target.index ? next : slot)),
      });
  };
  const route =
    picker?.role !== undefined ? plan?.roles?.[picker.role] : plan?.slots[picker?.index ?? -1];
  const pickerTitle =
    picker?.role !== undefined
      ? t('agentPlan.pickRole', { name: picker.role })
      : t('agentPlan.pickLane', { n: (picker?.index ?? 0) + 1 });
  const policy = (allowed: unknown) =>
    t(
      allowed === true
        ? 'agentPlan.policy.allowed'
        : allowed === false
          ? 'agentPlan.policy.blocked'
          : 'agentPlan.policy.unknown',
    );
  const save = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current = await command('prefs.get', {}, ['prefs.updated']);
      const capabilities = state.results['session.start']?.['protocolCapabilities'];
      const patch = agentPlanPatch(
        base,
        plan,
        current['subagentModelPlan'],
        Array.isArray(capabilities) && capabilities.includes('session.subagent-plan-expected'),
      );
      await command('prefs.update', patch, ['key.operation_result']);
      const actual = await command('prefs.get', {}, ['prefs.updated']);
      if (!sameSetting(agentModelPlan(actual['subagentModelPlan']), plan))
        throw Error(t('agentPlan.unconfirmed'));
      if (!live.current) return;
      setBase(actual['subagentModelPlan']);
      original.current = plan;
      setPrefs(actual);
      setNotice(t('agentPlan.saved'));
    } catch (error) {
      if (live.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const editRoute = (label: string, value: Route, target: { index?: number; role?: string }) => (
    <AgentRoute
      key={label}
      label={label}
      value={value}
      disabled={busy || (plan?.followSessionModel === true && target.role === undefined)}
      catalogs={catalogId}
      onChange={(next) => updateRoute(target, next)}
      onPick={() => setPicker(target)}
    />
  );
  return (
    <>
      <Modal onClose={close} title={t('agentPlan.title')}>
        <div className="session-agent-plan">
          <header>
            <div>
              <span className="eyebrow">{t('agentPlan.eyebrow')}</span>
              <h2>{t('agentPlan.title')}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('agentPlan.close')}
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          <p>{t('agentPlan.intro')}</p>
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          <AgentPlanDraftStatus draft={saved} />
          {notice && (
            <p className="composer-notice" role="status">
              <Check size={14} />
              {notice}
            </p>
          )}
          {!loaded ? (
            <p role="status">
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} />
                  {t('agentPlan.reading')}
                </>
              ) : (
                t('agentPlan.retryHint')
              )}
            </p>
          ) : (
            plan && (
              <>
                <div className="agent-plan-policy">
                  <span>
                    {t('agentPlan.subagents', { value: policy(prefs['subagentsAllowed']) })}
                  </span>
                  <span>
                    {t('agentPlan.companions', {
                      value: policy(prefs['subagentCompanionsAllowed']),
                    })}
                  </span>
                  <span>
                    {t('agentPlan.chatModel', { provider: state.provider, model: state.model })}
                  </span>
                </div>
                <fieldset disabled={busy} className="agent-plan-switches">
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.enabled}
                      onChange={(event) => change({ ...plan, enabled: event.target.checked })}
                    />
                    {t('agentPlan.enable')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.lock}
                      onChange={(event) => change({ ...plan, lock: event.target.checked })}
                    />
                    {t('agentPlan.lock')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.followSessionModel}
                      onChange={(event) =>
                        change({ ...plan, followSessionModel: event.target.checked })
                      }
                    />
                    {t('agentPlan.follow')}
                  </label>
                </fieldset>
                <p className="field-help">{t('agentPlan.switchHelp')}</p>
                <section>
                  <header className="agent-plan-section">
                    <div>
                      <h3>{t('agentPlan.lanesTitle')}</h3>
                      <p>{t('agentPlan.lanesHelp')}</p>
                    </div>
                    <label>
                      {t('agentPlan.laneCount')}
                      <input
                        aria-label={t('agentPlan.laneCountLabel')}
                        type="number"
                        min={1}
                        max={16}
                        value={plan.slots.length}
                        disabled={busy}
                        onChange={(event) => {
                          const count = Number(event.target.value);
                          if (!Number.isInteger(count) || count < 1 || count > 16) return;
                          if (
                            count < plan.slots.length &&
                            plan.slots.slice(count).some((slot) => Object.keys(slot).length)
                          )
                            setResize(count);
                          else change(resizeAgentLanes(plan, count));
                        }}
                      />
                    </label>
                  </header>
                  {resize !== null && (
                    <div className="agent-plan-confirm" role="alert">
                      <p>
                        {t('agentPlan.removeLanesAsk', { from: resize + 1, to: plan.slots.length })}
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setResize(null)}
                      >
                        {t('agentPlan.keepLanes')}
                      </button>
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => {
                          change(resizeAgentLanes(plan, resize));
                          setResize(null);
                        }}
                      >
                        {t('agentPlan.removeLanes')}
                      </button>
                    </div>
                  )}
                  <div className="agent-plan-routes">
                    {plan.slots.map((slot, index) =>
                      editRoute(t('agentPlan.lane', { n: index + 1 }), slot, { index }),
                    )}
                  </div>
                </section>
                <section>
                  <header className="agent-plan-section">
                    <div>
                      <h3>{t('agentPlan.rolesTitle')}</h3>
                      <p>{t('agentPlan.rolesHelp')}</p>
                    </div>
                  </header>
                  <div className="agent-plan-role-create">
                    <input
                      aria-label={t('agentPlan.newRole')}
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                      placeholder={t('agentPlan.newRolePlaceholder')}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !role.trim()}
                      onClick={() => {
                        const name = role.trim();
                        if (
                          !/^[a-zA-Z0-9_:/.-]{1,80}$/.test(name) ||
                          Object.hasOwn(plan.roles ?? {}, name)
                        ) {
                          setError(t('agentPlan.roleInvalid'));
                          return;
                        }
                        change({
                          ...plan,
                          roles: {
                            ...plan.roles,
                            [name]: { modelRuntime: { reasoning: { mode: 'auto' } } },
                          },
                        });
                        setRole('');
                      }}
                    >
                      <Plus size={14} />
                      {t('agentPlan.addRole')}
                    </button>
                  </div>
                  {!Object.keys(plan.roles ?? {}).length && (
                    <p className="field-help">{t('agentPlan.noRoles')}</p>
                  )}
                  <div className="agent-plan-routes">
                    {Object.entries(plan.roles ?? {}).map(([name, value]) => (
                      <div key={name}>
                        {editRoute(t('agentPlan.role', { name }), value, { role: name })}
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          aria-label={t('agentPlan.removeRoleLabel', { name })}
                          onClick={() => {
                            const next = { ...plan.roles };
                            delete next[name];
                            const updated = { ...plan };
                            if (Object.keys(next).length) updated.roles = next;
                            else delete updated.roles;
                            change(updated);
                          }}
                        >
                          <Trash2 size={13} />
                          {t('agentPlan.removeRole')}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
                <datalist id={`${catalogId}-tier`}>
                  {Object.keys(record(prefs['modelTiers'])).map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <datalist id={`${catalogId}-profile`}>
                  {Object.keys(record(prefs['fallbackProfiles'])).map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </>
            )
          )}
          {discard && (
            <div className="agent-plan-confirm" role="alert">
              <p>{t('agentPlan.unsavedAsk')}</p>
              <button type="button" className="button secondary" onClick={() => setDiscard(false)}>
                {t('agentPlan.keepEditing')}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  saved.forget();
                  onClose();
                }}
              >
                {t('agentPlan.discardClose')}
              </button>
              <button type="button" className="button secondary" onClick={() => void load()}>
                {t('agentPlan.discardReload')}
              </button>
            </div>
          )}
          <footer>
            <span>{dirty ? t('agentPlan.unsaved') : t('agentPlan.savedPlan')}</span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => (dirty ? setDiscard(true) : void load())}
            >
              <RefreshCw size={14} />
              {t('agentPlan.reload')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              <Save size={14} />
              {t('agentPlan.save')}
            </button>
          </footer>
        </div>
      </Modal>
      {picker && (
        <Modal
          title={pickerTitle}
          onClose={() => {
            if (!pickerBusy) setPicker(null);
          }}
        >
          <ProfileModelPicker
            session={{
              ...state,
              provider: String(route?.['provider'] ?? state.provider),
              model: String(route?.['model'] ?? ''),
            }}
            title={pickerTitle}
            description={t('agentPlan.pickHelp')}
            onPick={(provider, model) => {
              updateRoute(picker, agentRouteTarget(route ?? {}, 'model', provider, model));
            }}
            onClose={() => setPicker(null)}
            onBusy={setPickerBusy}
          />
        </Modal>
      )}
    </>
  );
}

function AgentRoute({
  label,
  value,
  disabled,
  catalogs,
  onChange,
  onPick,
}: {
  label: string;
  value: Route;
  disabled: boolean;
  catalogs: string;
  onChange: (next: Route) => void;
  onPick: () => void;
}) {
  const { t } = useDesktopText();
  const storedMode =
    value['provider'] || value['model']
      ? 'model'
      : value['tier']
        ? 'tier'
        : value['fallbackProfile']
          ? 'profile'
          : 'inherit';
  const [mode, setMode] = useState(storedMode);
  useEffect(() => setMode(storedMode), [storedMode]);
  const runtime = record(value['modelRuntime']),
    reasoning = record(runtime['reasoning']);
  const changeReasoning = (key: string, text: string) => {
    const next = { ...reasoning };
    if (text) next[key] = key === 'preserve' ? text === 'true' : text;
    else delete next[key];
    const modelRuntime = { ...runtime };
    if (Object.keys(next).length) modelRuntime['reasoning'] = next;
    else delete modelRuntime['reasoning'];
    const updated = { ...value };
    if (Object.keys(modelRuntime).length) updated['modelRuntime'] = modelRuntime;
    else delete updated['modelRuntime'];
    onChange(updated);
  };
  return (
    <fieldset className="agent-plan-route" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        {t('agentPlan.route.label')}
        <input
          aria-label={t('agentPlan.route.labelField', { route: label })}
          value={String(value['label'] ?? '')}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value) next['label'] = event.target.value;
            else delete next['label'];
            onChange(next);
          }}
        />
      </label>
      <label>
        {t('agentPlan.route.source')}
        <select
          aria-label={t('agentPlan.route.sourceField', { route: label })}
          value={mode}
          onChange={(event) => {
            const selected = event.target.value;
            if (selected === 'model') onPick();
            else {
              setMode(selected as typeof mode);
              onChange(
                agentRouteTarget(
                  value,
                  selected,
                  selected === 'tier'
                    ? String(value['tier'] ?? '')
                    : selected === 'profile'
                      ? String(value['fallbackProfile'] ?? '')
                      : '',
                ),
              );
            }
          }}
        >
          {['inherit', 'model', 'tier', 'profile'].map((source) => (
            <option key={source} value={source}>
              {t(`agentPlan.route.sourceOption.${source}`)}
            </option>
          ))}
        </select>
      </label>
      {mode === 'model' ? (
        <button
          type="button"
          className="button secondary"
          aria-label={t('agentPlan.route.chooseField', { route: label })}
          onClick={onPick}
        >
          {String(value['provider'] ?? '*')}/{String(value['model'] ?? '*')}
        </button>
      ) : mode === 'tier' || mode === 'profile' ? (
        <label>
          {mode === 'tier' ? t('agentPlan.route.tier') : t('agentPlan.route.sourceOption.profile')}
          <input
            aria-label={t(
              mode === 'tier' ? 'agentPlan.route.tierField' : 'agentPlan.route.profileField',
              { route: label },
            )}
            list={`${catalogs}-${mode}`}
            value={String(value[mode === 'tier' ? 'tier' : 'fallbackProfile'] ?? '')}
            onChange={(event) => onChange(agentRouteTarget(value, mode, event.target.value))}
          />
        </label>
      ) : (
        <button
          type="button"
          className="button secondary"
          aria-label={t('agentPlan.route.chooseField', { route: label })}
          onClick={onPick}
        >
          {t('agentPlan.route.choose')}
        </button>
      )}
      <details>
        <summary>{t('agentPlan.route.reasoning')}</summary>
        <label>
          {t('agentPlan.route.mode')}
          <select
            aria-label={t('agentPlan.route.modeField', { route: label })}
            value={String(reasoning['mode'] ?? '')}
            onChange={(event) => changeReasoning('mode', event.target.value)}
          >
            {['', 'auto', 'on', 'off'].map((mode) => (
              <option key={mode} value={mode}>
                {mode ? t(`agentPlan.route.reasoningMode.${mode}`) : t('agentPlan.route.inherit')}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('agentPlan.route.effort')}
          <select
            aria-label={t('agentPlan.route.effortField', { route: label })}
            value={String(reasoning['effort'] ?? '')}
            onChange={(event) => changeReasoning('effort', event.target.value)}
          >
            <option value="">{t('agentPlan.route.inherit')}</option>
            {Object.entries(effortNames).map(([id, name]) => (
              <option key={id} value={id}>
                {t(`options.${id}`, { defaultValue: name })}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('agentPlan.route.preserve')}
          <select
            aria-label={t('agentPlan.route.preserveField', { route: label })}
            value={reasoning['preserve'] === undefined ? '' : String(reasoning['preserve'])}
            onChange={(event) => changeReasoning('preserve', event.target.value)}
          >
            <option value="">{t('agentPlan.route.inherit')}</option>
            <option value="true">{t('agentPlan.route.keep')}</option>
            <option value="false">{t('agentPlan.route.drop')}</option>
          </select>
        </label>
      </details>
    </fieldset>
  );
}
