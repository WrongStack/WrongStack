import type { AcpRuntimeSelections } from '@wrongstack/contracts/types/acp-runtime';
import { acpAgentName, isAcpProvider } from '@wrongstack/contracts/types/agent-identity';
import { Brain, ChevronDown, Fingerprint, TriangleAlert, Zap } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AcpRuntimeSettings, AcpSessionModes } from './AcpRuntimeSettings';
import { effortNames, sessionEffort, sessionReasoning } from './composer-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { identityLabel, sessionIdentity } from './identity-model';
import { Modal } from './Modal';
import { ModelQuickSwitcher } from './ModelQuickSwitcher';
import { ProfileModelPicker } from './ProfileModelPicker';

export function SessionModelControls({
  state,
  command,
  send,
  onSettings,
  settingsTarget,
}: {
  state: EngineState;
  command: EngineCommand;
  send: EngineSend;
  onSettings: () => void;
  /** Where the session's model settings (effort, reasoning, identity, ACP) are drawn; inline when unset. */
  settingsTarget?: HTMLElement | null | undefined;
}) {
  const { t } = useDesktopText();
  // The chip opens the quick switcher; its "All models" opens the full picker.
  const [open, setOpen] = useState<'' | 'switcher' | 'all'>(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const chip = useRef<HTMLButtonElement>(null);
  // The full picker opens from the switcher, which is gone when it closes: focus the chip.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === 'all' && !open) chip.current?.focus();
    wasOpen.current = open;
  }, [open]);
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
  const settingsGroup: ReactNode = (
    <div className="session-model-controls composer-setting-group">
      {state.provider === 'acp' && state.sessionId && (
        <AcpSessionModes
          key={`${state.sessionId}:${state.model}`}
          agentId={state.model}
          sessionId={state.sessionId}
          connected={state.connected && !state.hydrating}
          running={state.running}
          disabled={busy}
          command={command}
        />
      )}
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
          <span className="composer-setting-name">{t('composer.settings.effort')}</span>
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
          <Brain size={12} />
          <span className="composer-setting-name">{t('composer.settings.reasoning')}</span>
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
          <Fingerprint size={12} />
          <span className="composer-setting-name">{t('composer.settings.identity')}</span>
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
    </div>
  );
  return (
    <div className="session-model-controls">
      <button
        type="button"
        className="composer-chip model-selector"
        aria-label={t('modelControls.choose')}
        disabled={!state.connected || busy}
        title={t('modelControls.title', { provider: state.provider, model: state.model })}
        ref={chip}
        aria-expanded={open === 'switcher'}
        onClick={() => {
          if (state.needsSetup) {
            onSettings();
            return;
          }
          setError('');
          setOpen(open === 'switcher' ? '' : 'switcher');
        }}
      >
        <span className={`status-dot ${state.connected ? 'running' : 'starting'}`} />
        <span>
          {state.needsSetup
            ? t('modelControls.connect')
            : isAcpProvider(state.provider) && state.model
              ? acpAgentName(state.model)
              : state.model || t('modelControls.connecting')}
        </span>
        <ChevronDown size={11} />
      </button>
      {/* Undefined: no popover, draw inline. Null: the popover's slot has not mounted yet, so
          draw nothing rather than mount the group twice (ACP mode reads would run twice). */}
      {settingsTarget === undefined
        ? settingsGroup
        : settingsTarget && createPortal(settingsGroup, settingsTarget)}
      {!open && error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {open === 'switcher' && (
        <SwitcherPopover
          chip={chip.current}
          label={t('switcher.label')}
          onClose={() => setOpen('')}
        >
          <ModelQuickSwitcher
            session={state}
            sessionCommand={command}
            onBusy={setBusy}
            onClose={() => setOpen('')}
            onAllModels={() => setOpen('all')}
            onSettings={() => {
              setOpen('');
              onSettings();
            }}
          />
        </SwitcherPopover>
      )}
      {open === 'all' && (
        <Modal
          onClose={() => {
            if (!busy) setOpen('');
          }}
        >
          <ProfileModelPicker
            session={state}
            sessionCommand={command}
            onBusy={setBusy}
            onClose={() => setOpen('')}
            onSettings={() => {
              setOpen('');
              onSettings();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/**
 * The switcher's frame above the composer: Escape or a press outside it closes it, and focus
 * goes back to the model chip that opened it.
 */
function SwitcherPopover({
  chip,
  label,
  onClose,
  children,
}: {
  chip: HTMLButtonElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!frame.current?.contains(target) && !chip?.contains(target)) close.current();
    };
    // Escape closes it wherever focus is, as rows may still be loading when it is pressed.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close.current();
      chip?.focus();
    };
    // Keyboard use starts inside the switcher; its rows take focus once they arrive.
    if (!frame.current?.contains(document.activeElement)) frame.current?.focus();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [chip]);
  return (
    <div ref={frame} className="model-switcher" role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>
  );
}
