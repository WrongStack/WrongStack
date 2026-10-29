import { Check, LoaderCircle, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { effortNames } from './composer-model';
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
        throw Error(
          'The engine did not confirm the complete model plan. Your edits are kept; reload before retrying.',
        );
      if (!live.current) return;
      setBase(actual['subagentModelPlan']);
      original.current = plan;
      setPrefs(actual);
      setNotice(
        'Model plan saved and verified for this conversation. Existing workers keep their current assignments.',
      );
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
      <Modal onClose={close} title="Agent model plan">
        <div className="session-agent-plan">
          <header>
            <div>
              <span className="eyebrow">THIS CONVERSATION</span>
              <h2>Agent model plan</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close agent model plan"
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          <p>
            Choose models for future parallel workers in this session. The active chat model, other
            sessions and profile routing stay separate. Edits apply only after Save.
          </p>
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
                  Reading the session plan…
                </>
              ) : (
                'Use Reload saved plan to try again.'
              )}
            </p>
          ) : (
            plan && (
              <>
                <div className="agent-plan-policy">
                  <span>
                    Subagents:{' '}
                    {prefs['subagentsAllowed'] === true
                      ? 'Allowed'
                      : prefs['subagentsAllowed'] === false
                        ? 'Blocked'
                        : 'Not reported'}
                  </span>
                  <span>
                    Companions:{' '}
                    {prefs['subagentCompanionsAllowed'] === true
                      ? 'Allowed'
                      : prefs['subagentCompanionsAllowed'] === false
                        ? 'Blocked'
                        : 'Not reported'}
                  </span>
                  <span>
                    Chat model: {state.provider}/{state.model}
                  </span>
                </div>
                <fieldset disabled={busy} className="agent-plan-switches">
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.enabled}
                      onChange={(event) => change({ ...plan, enabled: event.target.checked })}
                    />
                    Enable this model plan
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.lock}
                      onChange={(event) => change({ ...plan, lock: event.target.checked })}
                    />
                    User model pins override leader choices
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={plan.followSessionModel}
                      onChange={(event) =>
                        change({ ...plan, followSessionModel: event.target.checked })
                      }
                    />
                    Follow the session model for plain workers
                  </label>
                </fieldset>
                <p className="field-help">
                  Disabling retains the plan. Role overrides take priority over lanes; following the
                  chat model retains lane pins for later use. This plan does not grant permission to
                  spawn workers.
                </p>
                <section>
                  <header className="agent-plan-section">
                    <div>
                      <h3>Parallel lanes</h3>
                      <p>Each active worker occupies a lane; released lanes can be reused.</p>
                    </div>
                    <label>
                      Lane count
                      <input
                        aria-label="Model lane count"
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
                        Remove lanes {resize + 1}–{plan.slots.length} and their stored model/runtime
                        choices from your draft?
                      </p>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setResize(null)}
                      >
                        Keep lanes
                      </button>
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => {
                          change(resizeAgentLanes(plan, resize));
                          setResize(null);
                        }}
                      >
                        Remove extra lanes
                      </button>
                    </div>
                  )}
                  <div className="agent-plan-routes">
                    {plan.slots.map((slot, index) =>
                      editRoute(`Lane ${index + 1}`, slot, { index }),
                    )}
                  </div>
                </section>
                <section>
                  <header className="agent-plan-section">
                    <div>
                      <h3>Role overrides</h3>
                      <p>Exact role matches outrank lanes and do not consume a lane.</p>
                    </div>
                  </header>
                  <div className="agent-plan-role-create">
                    <input
                      aria-label="New session role"
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                      placeholder="reviewer, architect…"
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
                          setError(
                            'Choose a unique role using letters, numbers, dots, slashes, colons, underscores or hyphens.',
                          );
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
                      Add role
                    </button>
                  </div>
                  {!Object.keys(plan.roles ?? {}).length && (
                    <p className="field-help">
                      No role overrides. Workers use lane or profile routing.
                    </p>
                  )}
                  <div className="agent-plan-routes">
                    {Object.entries(plan.roles ?? {}).map(([name, value]) => (
                      <div key={name}>
                        {editRoute(`Role ${name}`, value, { role: name })}
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          aria-label={`Remove session role ${name}`}
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
                          Remove role override
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
              <p>Your model plan has unsaved edits.</p>
              <button type="button" className="button secondary" onClick={() => setDiscard(false)}>
                Keep editing plan
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  saved.forget();
                  onClose();
                }}
              >
                Discard plan and close
              </button>
              <button type="button" className="button secondary" onClick={() => void load()}>
                Discard plan and reload
              </button>
            </div>
          )}
          <footer>
            <span>{dirty ? 'Unsaved session plan' : 'Saved session plan'}</span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => (dirty ? setDiscard(true) : void load())}
            >
              <RefreshCw size={14} />
              Reload saved plan
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              <Save size={14} />
              Save session plan
            </button>
          </footer>
        </div>
      </Modal>
      {picker && (
        <Modal
          title={`Choose ${picker.role !== undefined ? `role ${picker.role}` : `lane ${(picker.index ?? 0) + 1}`} model`}
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
            title={`Choose ${picker.role !== undefined ? `role ${picker.role}` : `lane ${(picker.index ?? 0) + 1}`} model`}
            description="Choose a current-profile model for this plan draft. A concrete model replaces tier/fallback targets; labels and runtime overrides are retained. The active chat model is unchanged."
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
        Label
        <input
          aria-label={`${label} label`}
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
        Model source
        <select
          aria-label={`${label} model source`}
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
          <option value="inherit">Inherit model routing</option>
          <option value="model">Specific model</option>
          <option value="tier">Cost/capability tier</option>
          <option value="profile">Fallback profile</option>
        </select>
      </label>
      {mode === 'model' ? (
        <button
          type="button"
          className="button secondary"
          aria-label={`${label} choose model`}
          onClick={onPick}
        >
          {String(value['provider'] ?? '*')}/{String(value['model'] ?? '*')}
        </button>
      ) : mode === 'tier' || mode === 'profile' ? (
        <label>
          {mode === 'tier' ? 'Tier' : 'Fallback profile'}
          <input
            aria-label={`${label} ${mode}`}
            list={`${catalogs}-${mode}`}
            value={String(value[mode === 'tier' ? 'tier' : 'fallbackProfile'] ?? '')}
            onChange={(event) => onChange(agentRouteTarget(value, mode, event.target.value))}
          />
        </label>
      ) : (
        <button
          type="button"
          className="button secondary"
          aria-label={`${label} choose model`}
          onClick={onPick}
        >
          Choose a model
        </button>
      )}
      <details>
        <summary>Reasoning overrides</summary>
        <label>
          Mode
          <select
            aria-label={`${label} reasoning mode`}
            value={String(reasoning['mode'] ?? '')}
            onChange={(event) => changeReasoning('mode', event.target.value)}
          >
            {['', 'auto', 'on', 'off'].map((mode) => (
              <option key={mode} value={mode}>
                {mode || 'Inherit'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effort
          <select
            aria-label={`${label} reasoning effort`}
            value={String(reasoning['effort'] ?? '')}
            onChange={(event) => changeReasoning('effort', event.target.value)}
          >
            <option value="">Inherit</option>
            {Object.entries(effortNames).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Preserve reasoning
          <select
            aria-label={`${label} preserve reasoning`}
            value={reasoning['preserve'] === undefined ? '' : String(reasoning['preserve'])}
            onChange={(event) => changeReasoning('preserve', event.target.value)}
          >
            <option value="">Inherit</option>
            <option value="true">Preserve</option>
            <option value="false">Discard</option>
          </select>
        </label>
      </details>
    </fieldset>
  );
}
