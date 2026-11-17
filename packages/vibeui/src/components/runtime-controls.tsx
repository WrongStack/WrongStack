'use client';

import { useEffect, useState } from 'react';
import { record, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { usePresentation } from './presentation-mode';

export function RuntimeControls({ controller }: { controller: SessionController }) {
  const { mode } = usePresentation();
  const { state, send, subscribe, connection, ready, compactPending, modelPending } = controller;
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending('');
      setError('Change was not confirmed. Reopen settings to refresh.');
    }, 10_000);
    const off = subscribe((frame) => {
      if (frame.type === 'prefs.updated' && pending !== 'mode') {
        const p = record(frame.payload);
        if (!(pending in p)) return;
        setPending('');
      }
      if (
        (frame.type === 'session.start' && pending === 'mode') ||
        frame.type === 'error' ||
        frame.type === 'key.operation_result'
      ) {
        if (
          frame.type === 'key.operation_result' &&
          record(frame.payload).success !== false &&
          pending !== 'mode'
        )
          return;
        if (frame.type === 'error' || record(frame.payload).success === false)
          setError(text(record(frame.payload).message) || 'The change could not be applied.');
        setPending('');
      }
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [pending, subscribe]);
  useEffect(() => {
    setPending('');
    setError('');
    send('prefs.get', { sessionId: state.id });
    send('modes.list', { sessionId: state.id });
  }, [state.id, send]);
  const disabled =
    connection !== 'open' || !ready || compactPending || modelPending || Boolean(pending);
  const change = (key: string, type: string, payload: Record<string, unknown>) => {
    setError('');
    if (send(type, { sessionId: state.id, ...payload })) setPending(key);
  };
  return (
    <section className="runtime-controls" aria-label="Runtime settings">
      <h3>Agent behavior</h3>
      <label className="settings-row">
        <span>
          <strong>Working mode</strong>
          <small>
            {state.modes.find((m) => m.id === state.mode)?.description ||
              'The instructions used by your agent.'}
          </small>
        </span>
        <select
          aria-label="Working mode"
          value={state.mode}
          disabled={disabled || state.running || !state.modes.length}
          onChange={(e) => change('mode', 'mode.switch', { id: e.target.value })}
        >
          {!state.modes.some((m) => m.id === state.mode) && (
            <option value={state.mode}>{state.mode || 'Loading…'}</option>
          )}
          {state.modes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row">
        <span>
          <strong>Autonomy</strong>
          <small>
            {state.prefs.autonomy === 'auto'
              ? 'Continue through follow-up work automatically.'
              : state.prefs.autonomy === 'suggest'
                ? 'Offer next steps for you to choose.'
                : 'Stop after the current request.'}
          </small>
        </span>
        <select
          aria-label="Autonomy"
          value={text(state.prefs.autonomy)}
          disabled={disabled || typeof state.prefs.autonomy !== 'string'}
          onChange={(e) => change('autonomy', 'autonomy.switch', { mode: e.target.value })}
        >
          {typeof state.prefs.autonomy === 'string' &&
            !['off', 'suggest', 'auto'].includes(state.prefs.autonomy) && (
              <option value={state.prefs.autonomy}>{state.prefs.autonomy} (current)</option>
            )}
          {typeof state.prefs.autonomy !== 'string' && <option value="">Loading…</option>}
          <option value="off">Off</option>
          <option value="suggest">Suggest</option>
          <option value="auto">Auto</option>
        </select>
      </label>
      <label className="settings-row">
        <span>
          <strong>YOLO</strong>
          <small>
            {state.prefs.yoloPlus === true
              ? 'Approve all calls, including subagents. Explicit deny rules still apply.'
              : state.prefs.yolo === true
                ? 'Approve standard calls; sensitive actions may still ask.'
                : 'Ask when permission is required.'}
          </small>
        </span>
        <select
          aria-label="YOLO mode"
          value={state.prefs.yoloPlus === true ? 'plus' : state.prefs.yolo === true ? 'on' : 'off'}
          disabled={disabled || typeof state.prefs.yolo !== 'boolean'}
          onChange={(e) =>
            change('yolo', 'prefs.update', {
              yolo: e.target.value !== 'off',
              yoloPlus: e.target.value === 'plus',
            })
          }
        >
          <option value="off">Off</option>
          <option value="on">YOLO</option>
          <option value="plus" disabled={typeof state.prefs.yoloPlus !== 'boolean'}>
            YOLO+
          </option>
        </select>
      </label>
      <label className="settings-row">
        <span>
          <strong>Next steps</strong>
          <small>
            Require suggestions or an explicit completion marker after each finished turn.
          </small>
        </span>
        <select
          aria-label="Next steps policy"
          value={text(state.prefs.nextStepsMode) || 'optional'}
          disabled={disabled}
          onChange={(e) =>
            change('nextStepsMode', 'prefs.update', { nextStepsMode: e.target.value })
          }
        >
          <option value="optional">Optional</option>
          <option value="required">Required</option>
        </select>
      </label>
      <details className="settings-group" key={`context-${mode}`} open={mode === 'extended'}>
        <summary>Context & efficiency</summary>
        <BooleanPreference
          name="Automatic compaction"
          hint="Allow the runtime to compact context when needed."
          pref="contextAutoCompact"
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
        <SelectPreference
          name="Compaction strategy"
          pref="contextStrategy"
          options={['hybrid', 'intelligent', 'selective']}
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
        <SelectPreference
          name="Context policy"
          pref="contextMode"
          options={['balanced', 'frugal', 'deep']}
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
        <SelectPreference
          name="Token saving"
          pref="tokenSavingTier"
          options={['auto', 'off', 'minimal', 'light', 'medium', 'aggressive']}
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
      </details>
      <details className="settings-group" key={`execution-${mode}`} open={mode === 'extended'}>
        <summary>Execution & delegation</summary>
        <NumberPreference
          name="Iteration limit"
          pref="maxIterations"
          value={state.prefs.maxIterations}
          disabled={disabled}
          change={change}
        />
        <NumberPreference
          name="Auto continuation limit"
          pref="autoProceedMaxIterations"
          value={state.prefs.autoProceedMaxIterations}
          disabled={disabled}
          change={change}
        />
        <BooleanPreference
          name="Allow subagents"
          hint="Let this session delegate work to other agents."
          pref="subagentsAllowed"
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
        <BooleanPreference
          name="Allow companion agents"
          hint="Allow background companions for this session."
          pref="subagentCompanionsAllowed"
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
      </details>
      <details className="settings-group" key={`refiner-${mode}`} open={mode === 'extended'}>
        <summary>Refiner & reasoning</summary>
        <label className="settings-row">
          <span>
            <strong>Refiner model</strong>
            <small>Used by the prompt refiner before you send a message.</small>
          </span>
          <select
            aria-label="Refiner model"
            disabled={disabled}
            value={
              text(state.prefs.refinerProvider) && text(state.prefs.refinerModel)
                ? `${state.prefs.refinerProvider}\t${state.prefs.refinerModel}`
                : ''
            }
            onChange={(event) => {
              const [provider = '', model = ''] = event.target.value.split('\t');
              change('refinerModel', 'prefs.update', {
                refinerProvider: provider,
                refinerModel: model,
              });
            }}
          >
            <option value="">Follow current model</option>
            {text(state.prefs.refinerProvider) &&
              text(state.prefs.refinerModel) &&
              !(
                Object.hasOwn(state.models, text(state.prefs.refinerProvider)) &&
                state.models[text(state.prefs.refinerProvider)]?.some(
                  (model) => model.id === state.prefs.refinerModel,
                )
              ) && (
                <option value={`${state.prefs.refinerProvider}\t${state.prefs.refinerModel}`}>
                  {text(state.prefs.refinerModel)} (saved)
                </option>
              )}
            {Object.entries(state.models).map(([provider, models]) => (
              <optgroup key={provider} label={provider}>
                {models.map((model) => (
                  <option key={model.id} value={`${provider}\t${model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <BooleanPreference
          name="Show model reasoning"
          hint="Show collapsible thinking blocks in this conversation."
          pref="showModelReasoning"
          prefs={state.prefs}
          disabled={disabled}
          change={change}
        />
      </details>
      {pending && (
        <p className="fine-print" role="status">
          Waiting for the agent to confirm…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type PreferenceChange = (key: string, type: string, payload: Record<string, unknown>) => void;
function BooleanPreference({
  name,
  hint,
  pref,
  prefs,
  disabled,
  change,
}: {
  name: string;
  hint: string;
  pref: string;
  prefs: Record<string, unknown>;
  disabled: boolean;
  change: PreferenceChange;
}) {
  return (
    <label className="settings-row">
      <span>
        <strong>{name}</strong>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        aria-label={name}
        checked={prefs[pref] === true}
        disabled={disabled || typeof prefs[pref] !== 'boolean'}
        onChange={(event) => change(pref, 'prefs.update', { [pref]: event.target.checked })}
      />
    </label>
  );
}
function SelectPreference({
  name,
  pref,
  options,
  prefs,
  disabled,
  change,
}: {
  name: string;
  pref: string;
  options: string[];
  prefs: Record<string, unknown>;
  disabled: boolean;
  change: PreferenceChange;
}) {
  const current = text(prefs[pref]);
  return (
    <label className="settings-row">
      <strong>{name}</strong>
      <select
        aria-label={name}
        value={current}
        disabled={disabled || typeof prefs[pref] !== 'string'}
        onChange={(event) => change(pref, 'prefs.update', { [pref]: event.target.value })}
      >
        {!options.includes(current) && <option value={current}>{current || 'Not reported'}</option>}
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
function NumberPreference({
  name,
  pref,
  value,
  disabled,
  change,
}: {
  name: string;
  pref: string;
  value: unknown;
  disabled: boolean;
  change: PreferenceChange;
}) {
  return (
    <NumberPreferenceField
      key={String(value)}
      name={name}
      pref={pref}
      value={value}
      disabled={disabled}
      change={change}
    />
  );
}
function NumberPreferenceField({
  name,
  pref,
  value,
  disabled,
  change,
}: {
  name: string;
  pref: string;
  value: unknown;
  disabled: boolean;
  change: PreferenceChange;
}) {
  const [draft, setDraft] = useState(typeof value === 'number' ? String(value) : '');
  const valid = /^\d+$/.test(draft) && Number(draft) <= 100000;
  return (
    <form
      className="settings-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) change(pref, 'prefs.update', { [pref]: Number(draft) });
      }}
    >
      <label htmlFor={`preference-${pref}`}>
        <strong>{name}</strong>
        <small>0 means unlimited.</small>
      </label>
      <div className="preference-number">
        <input
          type="number"
          id={`preference-${pref}`}
          aria-label={name}
          value={draft}
          min={0}
          max={100000}
          step={1}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled || typeof value !== 'number'}
        />
        <button
          type="submit"
          className="secondary-button"
          aria-label={`Apply ${name.toLowerCase()}`}
          disabled={disabled || !valid || Number(draft) === value}
        >
          Apply
        </button>
      </div>
    </form>
  );
}
