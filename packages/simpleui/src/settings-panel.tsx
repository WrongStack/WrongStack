import { Settings, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AUTONOMY_MODES, type AutonomyMode, type SimplePrefs } from './lib/prefs-model.js';
import type { AgentMode } from './types.js';

interface SettingsPanelProps {
  open: boolean;
  prefs: SimplePrefs;
  modes: AgentMode[];
  activeModeId: string;
  connection: string;
  onClose: () => void;
  onAutonomyChange: (mode: AutonomyMode) => void;
  onModeChange: (id: string) => void;
  onPrefChange: (patch: Partial<SimplePrefs>) => void;
}

const AUTONOMY_HINT: Record<AutonomyMode, string> = {
  off: 'You drive every turn.',
  suggest: 'Agent proposes the next step; you confirm.',
  auto: 'Agent proceeds on its own between turns.',
};

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (value: boolean) => void;
}

function ToggleRow({ label, hint, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <label className={`settings-toggle${disabled ? ' disabled' : ''}`}>
      <span className="settings-toggle-copy">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-switch" aria-hidden="true" />
    </label>
  );
}

export function SettingsPanel({
  open,
  prefs,
  modes,
  activeModeId,
  connection,
  onClose,
  onAutonomyChange,
  onModeChange,
  onPrefChange,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;
  const offline = connection !== 'open';

  return (
    <>
      <button
        type="button"
        className="settings-overlay"
        aria-label="Close settings"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        className="settings-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header className="settings-head">
          <span>
            <Settings size={13} aria-hidden="true" /> SETTINGS
          </span>
          <button type="button" onClick={onClose} aria-label="Close settings" ref={closeRef}>
            <X size={14} />
          </button>
        </header>

        <div className="settings-body">
          {offline && <p className="settings-offline">Disconnected — settings are read-only.</p>}

          <section className="settings-group" aria-label="Autonomy">
            <h2>AUTONOMY</h2>
            <div className="settings-segmented" role="radiogroup" aria-label="Autonomy mode">
              {AUTONOMY_MODES.map((mode) => (
                <label
                  className={`settings-segment${prefs.autonomy === mode ? ' active' : ''}`}
                  key={mode}
                >
                  <input
                    type="radio"
                    name="autonomy"
                    value={mode}
                    checked={prefs.autonomy === mode}
                    disabled={offline}
                    onChange={() => onAutonomyChange(mode)}
                  />
                  <span>{mode}</span>
                </label>
              ))}
            </div>
            <small className="settings-hint">{AUTONOMY_HINT[prefs.autonomy]}</small>
            <ToggleRow
              label="YOLO"
              hint="Auto-approve tool permissions, including pending ones."
              checked={prefs.yolo}
              disabled={offline}
              onChange={(yolo) => onPrefChange({ yolo })}
            />
          </section>

          <section className="settings-group" aria-label="Refine">
            <h2>REFINE</h2>
            <ToggleRow
              label="Refine prompts"
              hint="Rewrite each message before sending, with a review step."
              checked={prefs.enhanceEnabled}
              disabled={offline}
              onChange={(enhanceEnabled) => onPrefChange({ enhanceEnabled })}
            />
            <small className="settings-hint">
              Refine adds a review step before sending. Language follows the saved server preference.
            </small>
          </section>

          <section className="settings-group" aria-label="Mode">
            <h2>MODE</h2>
            <label className="settings-field">
              <span>Agent mode</span>
              <select
                value={activeModeId}
                disabled={offline || modes.length === 0}
                onChange={(event) => onModeChange(event.target.value)}
              >
                {modes.length === 0 ? (
                  <option value={activeModeId}>{activeModeId}</option>
                ) : (
                  modes.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <small className="settings-hint">
              {modes.find((mode) => mode.id === activeModeId)?.description ?? 'Default behaviour.'}
            </small>
          </section>

          <section className="settings-group" aria-label="Session">
            <h2>SESSION</h2>
            <ToggleRow
              label="Model reasoning"
              hint="Show the model's thinking and reasoning in the chat."
              checked={prefs.showModelReasoning}
              disabled={offline}
              onChange={(showModelReasoning) => onPrefChange({ showModelReasoning })}
            />
            <ToggleRow
              label="Chime"
              hint="Play a sound when a run finishes."
              checked={prefs.chime}
              disabled={offline}
              onChange={(chime) => onPrefChange({ chime })}
            />
            <ToggleRow
              label="Confirm exit"
              hint="Ask before quitting with a run in flight."
              checked={prefs.confirmExit}
              disabled={offline}
              onChange={(confirmExit) => onPrefChange({ confirmExit })}
            />
          </section>
        </div>
      </aside>
    </>
  );
}
