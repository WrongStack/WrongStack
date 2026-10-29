import { ChevronDown, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { effortNames, sessionEffort, sessionReasoning } from './composer-model';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';

export function SessionModelControls({
  state,
  command,
  send,
  onSettings,
}: {
  state: EngineState;
  command: EngineCommand;
  send: EngineSend;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [supersededLeader, setSupersededLeader] = useState<unknown>(null);
  const effort = sessionEffort(state, supersededLeader === state.results['leader.effort_changed']);
  const reasoning = sessionReasoning(state);
  useEffect(() => {
    if (!state.connected || state.hydrating) return;
    void send('prefs.get').catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [state.connected, state.hydrating, state.provider, state.model, send]);
  const chooseEffort = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      await command('prefs.update', { reasoningEffort: value }, ['key.operation_result']);
      const actual = await command('prefs.get', {}, ['prefs.updated']);
      if (actual['reasoningEffort'] !== value)
        throw Error('The session did not confirm this effort. Refresh before retrying.');
      setSupersededLeader(state.results['leader.effort_changed']);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /** A session-scoped reasoning preference, confirmed by reading the session back. */
  const chooseReasoning = async (key: 'reasoningMode' | 'reasoningPreserve', value: unknown) => {
    setBusy(true);
    setError('');
    try {
      await command('prefs.update', { [key]: value }, ['key.operation_result']);
      const actual = await command('prefs.get', {}, ['prefs.updated']);
      if (actual[key] !== value)
        throw Error('The session did not confirm this reasoning setting. Refresh before retrying.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="session-model-controls">
      <button
        type="button"
        className="composer-chip model-selector"
        aria-label="Choose session model"
        disabled={!state.connected || busy}
        title={`${state.provider} / ${state.model} · changes apply to the next request`}
        onClick={() => {
          if (state.needsSetup) {
            onSettings();
            return;
          }
          setError('');
          setOpen(true);
        }}
      >
        <span className={`status-dot ${state.connected ? 'running' : 'starting'}`} />
        <span>{state.needsSetup ? 'Connect provider' : state.model || 'Connecting…'}</span>
        <ChevronDown size={11} />
      </button>
      {!effort.hidden && (
        <label
          className="composer-chip effort-control"
          title={
            effort.reason || 'Reasoning effort for this session. Auto follows the project setting.'
          }
        >
          <Zap size={12} />
          <select
            aria-label="Session reasoning effort"
            disabled={!state.connected || busy || state.needsSetup}
            value={effort.current}
            onChange={(e) => void chooseEffort(e.target.value)}
          >
            <option value="auto">Auto effort</option>
            {effort.options.map((level) => (
              <option key={level} value={level}>
                {effortNames[level]}
              </option>
            ))}
          </select>
        </label>
      )}
      {reasoning && !reasoning.alwaysOn && (
        <label
          className="composer-chip effort-control"
          title="Reasoning for this session. Auto follows the provider and project setting."
        >
          <select
            aria-label="Session reasoning"
            disabled={!state.connected || busy || state.needsSetup}
            value={reasoning.mode}
            onChange={(e) => void chooseReasoning('reasoningMode', e.target.value)}
          >
            <option value="auto">Auto reasoning</option>
            <option value="on">Reasoning on</option>
            {(reasoning.canDisable || reasoning.mode === 'off') && (
              <option value="off">Reasoning off</option>
            )}
          </select>
        </label>
      )}
      {reasoning?.preserve === 'optional' && (
        <label
          className="composer-chip effort-control"
          title="Send earlier reasoning back to the model on later turns, as this model allows."
        >
          <input
            type="checkbox"
            aria-label="Keep reasoning between turns"
            disabled={!state.connected || busy || state.needsSetup}
            checked={reasoning.preserveOn}
            onChange={(e) => void chooseReasoning('reasoningPreserve', e.target.checked)}
          />
          Keep reasoning
        </label>
      )}
      {effort.hint && (
        <small className="composer-effort-hint" title={effort.reason}>
          {effort.hint}
        </small>
      )}
      {effort.unsupported && (
        <small className="composer-effort-hint">
          Saved effort is not advertised by this model.
        </small>
      )}
      {!open && error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <Modal
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <ProfileModelPicker
            session={state}
            sessionCommand={command}
            onBusy={setBusy}
            onClose={() => setOpen(false)}
            onSettings={() => {
              setOpen(false);
              onSettings();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
