import type { AcpRuntimeSelections } from '@wrongstack/contracts/types/acp-runtime';
import { ChevronDown, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AcpRuntimeSettings } from './AcpRuntimeSettings';
import { effortNames, sessionEffort, sessionReasoning } from './composer-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { identityLabel, sessionIdentity } from './identity-model';
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
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [supersededLeader, setSupersededLeader] = useState<unknown>(null);
  const effort = sessionEffort(state, supersededLeader === state.results['leader.effort_changed']);
  const reasoning = sessionReasoning(state);
  const identity = sessionIdentity(
    state.results['system_prompt.info'],
    state.results['prefs.updated'],
  );
  const identityHint = identity.options.find((option) => option.variant === identity.current)?.hint;
  useEffect(() => {
    if (!state.connected || state.hydrating) return;
    void send('prefs.get').catch((e) => setError(String(e instanceof Error ? e.message : e)));
    void send('system_prompt.get').catch(() => {});
  }, [state.connected, state.hydrating, state.provider, state.model, send]);
  const chooseEffort = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      await command('prefs.update', { reasoningEffort: value }, ['key.operation_result']);
      const actual = await command('prefs.get', {}, ['prefs.updated']);
      if (actual['reasoningEffort'] !== value) throw Error(t('modelControls.effortNotConfirmed'));
      setSupersededLeader(state.results['leader.effort_changed']);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /** A session-scoped preference, confirmed by reading the session back. */
  const chooseReasoning = async (
    key: 'reasoningMode' | 'reasoningPreserve' | 'systemPromptVariant',
    value: unknown,
  ) => {
    setBusy(true);
    setError('');
    try {
      await command('prefs.update', { [key]: value }, ['key.operation_result']);
      const actual = await command('prefs.get', {}, ['prefs.updated']);
      if (actual[key] !== value) throw Error(t('modelControls.notConfirmed'));
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
        aria-label={t('modelControls.choose')}
        disabled={!state.connected || busy}
        title={t('modelControls.title', { provider: state.provider, model: state.model })}
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
        <span>
          {state.needsSetup
            ? t('modelControls.connect')
            : state.model || t('modelControls.connecting')}
        </span>
        <ChevronDown size={11} />
      </button>
      {state.provider === 'acp' && (
        <AcpRuntimeSettings
          key={state.model}
          agentId={state.model}
          command={command}
          disabled={!state.connected || busy}
          values={
            (state.results['prefs.updated']?.['acpRuntime'] as AcpRuntimeSelections | undefined)?.[
              state.model
            ]
          }
          onChange={async (values) => {
            const settings = state.results['prefs.updated']?.['acpRuntime'] as
              | AcpRuntimeSelections
              | undefined;
            const next = { ...settings, [state.model]: values };
            await command('prefs.update', { acpRuntime: next }, ['key.operation_result']);
            const actual = await command('prefs.get', {}, ['prefs.updated']);
            if (JSON.stringify(actual['acpRuntime']) !== JSON.stringify(next))
              throw Error(t('modelControls.notConfirmed'));
          }}
        />
      )}
      {state.provider !== 'acp' && !effort.hidden && (
        <label
          className="composer-chip effort-control"
          title={effort.reason || t('modelControls.effortTitle')}
        >
          <Zap size={12} />
          <select
            aria-label={t('modelControls.effortLabel')}
            disabled={!state.connected || busy || state.needsSetup}
            value={effort.current}
            onChange={(e) => void chooseEffort(e.target.value)}
          >
            <option value="auto">
              {effort.projectEffort
                ? t('modelControls.autoEffortProject', {
                    effort: t(`options.${effort.projectEffort}`, {
                      defaultValue: effortNames[effort.projectEffort],
                    }),
                  })
                : t('modelControls.autoEffort')}
            </option>
            {effort.options.map((level) => (
              <option key={level} value={level}>
                {t(`options.${level}`, { defaultValue: effortNames[level] })}
              </option>
            ))}
          </select>
        </label>
      )}
      {state.provider !== 'acp' && reasoning && !reasoning.alwaysOn && (
        <label className="composer-chip effort-control" title={t('modelControls.reasoningTitle')}>
          <select
            aria-label={t('modelControls.reasoningLabel')}
            disabled={!state.connected || busy || state.needsSetup}
            value={reasoning.mode}
            onChange={(e) => void chooseReasoning('reasoningMode', e.target.value)}
          >
            <option value="auto">{t('modelControls.reasoningAuto')}</option>
            <option value="on">{t('modelControls.reasoningOn')}</option>
            {(reasoning.canDisable || reasoning.mode === 'off') && (
              <option value="off">{t('modelControls.reasoningOff')}</option>
            )}
          </select>
        </label>
      )}
      {reasoning?.preserve === 'optional' && (
        <label className="composer-chip effort-control" title={t('modelControls.preserveTitle')}>
          <input
            type="checkbox"
            aria-label={t('modelControls.preserveLabel')}
            disabled={!state.connected || busy || state.needsSetup}
            checked={reasoning.preserveOn}
            onChange={(e) => void chooseReasoning('reasoningPreserve', e.target.checked)}
          />
          {t('modelControls.preserve')}
        </label>
      )}
      {identity.options.length > 1 && (
        <label
          className="composer-chip effort-control"
          title={
            identityHint
              ? t('modelControls.identityTitleHint', { hint: identityHint })
              : t('modelControls.identityTitle')
          }
        >
          <select
            aria-label={t('modelControls.identityLabel')}
            disabled={!state.connected || busy || state.needsSetup}
            value={identity.current}
            onChange={(e) => void chooseReasoning('systemPromptVariant', e.target.value)}
          >
            {!identity.options.some((option) => option.variant === identity.current) && (
              <option value={identity.current}>{identity.current}</option>
            )}
            {identity.options.map((option) => (
              <option key={option.variant} value={option.variant} title={option.hint}>
                {identityLabel(option, (tokens) => t('modelControls.identityTokens', { tokens }))}
              </option>
            ))}
          </select>
        </label>
      )}
      {effort.leaderEffort && (
        <small className="composer-effort-hint" title={effort.reason}>
          {t('modelControls.leader', { effort: effort.leaderEffort })}
        </small>
      )}
      {/* An icon with the sentence as its name, not a sentence wedged between the controls. */}
      {effort.unsupported && (
        <span
          className="composer-effort-warning"
          role="img"
          aria-label={t('modelControls.unsupported')}
          title={t('modelControls.unsupported')}
        >
          <TriangleAlert size={14} />
        </span>
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
