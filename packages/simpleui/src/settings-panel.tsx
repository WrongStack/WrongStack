import { Search, Settings, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { AUTONOMY_MODES, type AutonomyMode, type SimplePrefs } from './lib/prefs-model.js';
import { PALETTES, type PaletteId } from './lib/palettes.js';
import { groupCatalog, matchesQuery } from './lib/settings-catalog.js';
import type { AgentMode } from './types.js';

interface SettingsPanelProps {
  open: boolean;
  prefs: SimplePrefs;
  modes: AgentMode[];
  activeModeId: string;
  palette: PaletteId;
  connection: string;
  onClose: () => void;
  onAutonomyChange: (mode: AutonomyMode) => void;
  onModeChange: (id: string) => void;
  onPaletteChange: (palette: PaletteId) => void;
  onPrefChange: (patch: Partial<SimplePrefs>) => void;
  /** Reset every pref to DEFAULT_PREFS — wired up to useSettings().resetPrefs. */
  onReset: () => void;
  /** True when the current prefs already match DEFAULT_PREFS. */
  isAtDefaults: boolean;
  subagentPolicyLocked: boolean;
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
  /** Stable catalog id, used by the search/filter to hide this row. */
  settingId?: string;
  /** Force-hide the row (used by the search/filter). */
  hidden?: boolean | undefined;
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  settingId,
  hidden,
}: ToggleRowProps) {
  return (
    <label
      className={`settings-toggle${disabled ? ' disabled' : ''}`}
      data-setting-id={settingId}
      style={hidden ? { display: 'none' } : undefined}
    >
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

/**
 * Inline "X of Y" badge that sits inside a group heading while a filter is
 * active. Renders nothing when `label` is null so the heading stays clean
 * in the unfiltered state. Visually muted and accessible: the badge is
 * marked `aria-live="polite"` on its container so screen readers hear
 * counts change as the user types.
 */
function GroupCount({ groupId, label }: { groupId: string; label: string | null }) {
  if (label === null) return null;
  return (
    <span className="settings-group-count" data-group-count={groupId} aria-live="polite">
      {label}
    </span>
  );
}

export function SettingsPanel({
  open,
  prefs,
  modes,
  activeModeId,
  palette,
  connection,
  onClose,
  onAutonomyChange,
  onModeChange,
  onPaletteChange,
  onPrefChange,
  onReset,
  isAtDefaults,
  subagentPolicyLocked,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(panelRef, true);
  // Inline confirmation state for the Reset-to-defaults button. Two-step
  // confirm (button → confirm row) avoids accidentally wiping every pref
  // when the user clicks while reaching for another control.
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const resetButtonRef = useRef<HTMLButtonElement | null>(null);
  const resetConfirmRef = useRef<HTMLDivElement | null>(null);
  const resetCancelRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Two-tier query state: `query` is what the user typed (instant feedback,
  // re-renders on every keystroke), `debouncedQuery` is what the filter
  // actually runs against (settles 150 ms after typing stops). Keeping the
  // raw string on the controlled input avoids losing keystrokes while the
  // debounce timer is in flight, and keeps the visible input value in sync
  // with the clear button.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(handle);
  }, [query]);

  // Compute visibility per entry id, per group id, and a per-group
  // "X of Y" count for the heading badge. Catalog is stable; recomputing
  // once per debounced-query change is cheap.
  const { visibleEntries, visibleGroups, groupCounts } = useMemo(() => {
    const entries = new Set<string>();
    const groups = new Set<string>();
    const counts: Record<string, { visible: number; total: number }> = {};
    for (const { group, entries: groupEntries } of groupCatalog()) {
      counts[group.id] = { visible: 0, total: groupEntries.length };
      for (const entry of groupEntries) {
        if (matchesQuery(entry, group.title, debouncedQuery)) {
          entries.add(entry.id);
          groups.add(group.id);
          counts[group.id].visible += 1;
        }
      }
    }
    return { visibleEntries: entries, visibleGroups: groups, groupCounts: counts };
  }, [debouncedQuery]);
  const isFiltering = debouncedQuery.trim().length > 0;
  const hasResults = visibleEntries.size > 0;
  // Helper: hide a row only when actively filtering and the entry is not
  // visible. Outside of a query, every row stays in normal flow.
  const rowHidden = (id: string): boolean => isFiltering && !visibleEntries.has(id);
  const groupHidden = (id: string): boolean => isFiltering && !visibleGroups.has(id);
  // "X of Y" count text for a group heading. Empty when not filtering.
  const groupCountLabel = (id: string): string | null => {
    if (!isFiltering) return null;
    const count = groupCounts[id];
    if (!count) return null;
    return `${count.visible} of ${count.total}`;
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // When the panel closes (route change, Escape, overlay click), drop the
  // open/closed state of the inline reset confirm so re-opening the panel
  // shows the default "Reset to defaults" button — not a half-rendered
  // confirm row from a previous open.
  useEffect(() => {
    if (!open) setResetConfirmOpen(false);
  }, [open]);

  // When the reset confirm row opens, move focus onto the Cancel button so a
  // sighted keyboard user can dismiss it with one Enter. Returning focus to
  // the Reset button on close keeps the keyboard path predictable.
  useEffect(() => {
    if (resetConfirmOpen) {
      resetCancelRef.current?.focus();
    } else {
      resetButtonRef.current?.focus();
    }
  }, [resetConfirmOpen]);

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
        tabIndex={-1}
      >
        <header className="settings-head">
          <span>
            <Settings size={13} aria-hidden="true" /> SETTINGS
          </span>
          <div className="settings-head-actions">
            <button
              type="button"
              className="settings-reset"
              onClick={() => setResetConfirmOpen((open) => !open)}
              aria-expanded={resetConfirmOpen}
              aria-controls="settings-reset-confirm"
              disabled={isAtDefaults || offline}
              aria-disabled={isAtDefaults || offline}
              ref={resetButtonRef}
            >
              {isAtDefaults ? 'Defaults applied' : 'Reset to defaults'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close settings" ref={closeRef}>
              <X size={14} />
            </button>
          </div>
        </header>
        {resetConfirmOpen && !isAtDefaults ? (
          <div
            id="settings-reset-confirm"
            className="settings-reset-confirm"
            role="alertdialog"
            aria-live="polite"
            aria-label="Reset to defaults confirmation"
            ref={resetConfirmRef}
          >
            <p>
              Reset every setting to its default? This will affect autonomy, yolo, refine, model
              reasoning, chime, and confirm-exit.
            </p>
            <div className="settings-reset-actions">
              <button
                type="button"
                className="settings-reset-cancel"
                ref={resetCancelRef}
                onClick={() => {
                  setResetConfirmOpen(false);
                  resetButtonRef.current?.focus();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-reset-confirm-btn"
                onClick={() => {
                  onReset();
                  setResetConfirmOpen(false);
                  resetButtonRef.current?.focus();
                }}
                disabled={offline}
                aria-disabled={offline}
              >
                Reset everything
              </button>
            </div>
          </div>
        ) : null}

        <div className="settings-search">
          <Search size={14} aria-hidden="true" className="settings-search-icon" />
          <input
            type="search"
            className="settings-search-input"
            placeholder="Filter settings"
            aria-label="Filter settings"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {isFiltering ? (
            <button
              type="button"
              className="clear"
              aria-label="Clear filter"
              onClick={() => setQuery('')}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className="settings-body">
          {offline && <p className="settings-offline">Disconnected — settings are read-only.</p>}

          <section
            className="settings-group"
            aria-label="Autonomy"
            data-group-id="autonomy"
            style={groupHidden('autonomy') ? { display: 'none' } : undefined}
          >
            <h2>
              AUTONOMY
              <GroupCount groupId="autonomy" label={groupCountLabel('autonomy')} />
            </h2>
            <div
              className="settings-segmented"
              role="radiogroup"
              aria-label="Autonomy mode"
              data-setting-id="autonomy.mode"
              style={rowHidden('autonomy.mode') ? { display: 'none' } : undefined}
            >
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
              settingId="autonomy.yolo"
              hidden={rowHidden('autonomy.yolo')}
            />
          </section>

          <section
            className="settings-group"
            aria-label="Refine"
            data-group-id="refine"
            style={groupHidden('refine') ? { display: 'none' } : undefined}
          >
            <h2>
              REFINE
              <GroupCount groupId="refine" label={groupCountLabel('refine')} />
            </h2>
            <ToggleRow
              label="Refine prompts"
              hint="Rewrite each message before sending, with a review step."
              checked={prefs.enhanceEnabled}
              disabled={offline}
              onChange={(enhanceEnabled) => onPrefChange({ enhanceEnabled })}
              settingId="refine.enhanceEnabled"
              hidden={rowHidden('refine.enhanceEnabled')}
            />
            <small className="settings-hint">
              Refine adds a review step before sending. Language follows the saved server
              preference.
            </small>
          </section>

          <section
            className="settings-group"
            aria-label="Mode"
            data-group-id="mode"
            style={groupHidden('mode') ? { display: 'none' } : undefined}
          >
            <h2>
              MODE
              <GroupCount groupId="mode" label={groupCountLabel('mode')} />
            </h2>
            <label
              className="settings-field"
              data-setting-id="mode.agentMode"
              style={rowHidden('mode.agentMode') ? { display: 'none' } : undefined}
            >
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

          <section
            className="settings-group"
            aria-label="Color Palette"
            data-group-id="palette"
            style={groupHidden('palette') ? { display: 'none' } : undefined}
          >
            <h2>
              COLOR PALETTE
              <GroupCount groupId="palette" label={groupCountLabel('palette')} />
            </h2>
            <div
              className="settings-palettes"
              data-setting-id="palette.color"
              style={rowHidden('palette.color') ? { display: 'none' } : undefined}
            >
              {PALETTES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-palette${palette === option.id ? ' active' : ''}`}
                  aria-pressed={palette === option.id}
                  onClick={() => onPaletteChange(option.id)}
                >
                  <span
                    className="settings-palette-swatch"
                    aria-hidden="true"
                    style={{
                      background: `linear-gradient(90deg, ${option.swatch} 0 50%, ${option.swatchSecondary} 50% 100%)`,
                    }}
                  />
                  {option.label}
                </button>
              ))}
            </div>
            <small className="settings-hint">Pick the main color accent for the interface.</small>
          </section>

          <section
            className="settings-group"
            aria-label="Session"
            data-group-id="session"
            style={groupHidden('session') ? { display: 'none' } : undefined}
          >
            <h2>
              SESSION
              <GroupCount groupId="session" label={groupCountLabel('session')} />
            </h2>
            <ToggleRow
              label="Solo session"
              hint={
                subagentPolicyLocked || prefs.subagentsPolicyLocked
                  ? 'Locked for this session. Start a new session to change it.'
                  : 'Block Chimera, delegation, and every background subagent.'
              }
              checked={!prefs.subagentsAllowed}
              disabled={offline || subagentPolicyLocked || prefs.subagentsPolicyLocked}
              onChange={(solo) => onPrefChange({ subagentsAllowed: !solo })}
              settingId="session.solo"
              hidden={rowHidden('session.solo')}
            />
            <ToggleRow
              label="Model reasoning"
              hint="Show the model's thinking and reasoning in the chat."
              checked={prefs.showModelReasoning}
              disabled={offline}
              onChange={(showModelReasoning) => onPrefChange({ showModelReasoning })}
              settingId="session.showModelReasoning"
              hidden={rowHidden('session.showModelReasoning')}
            />
            <ToggleRow
              label="Chime"
              hint="Play a sound when a run finishes."
              checked={prefs.chime}
              disabled={offline}
              onChange={(chime) => onPrefChange({ chime })}
              settingId="session.chime"
              hidden={rowHidden('session.chime')}
            />
            <ToggleRow
              label="Confirm exit"
              hint="Ask before quitting with a run in flight."
              checked={prefs.confirmExit}
              disabled={offline}
              onChange={(confirmExit) => onPrefChange({ confirmExit })}
              settingId="session.confirmExit"
              hidden={rowHidden('session.confirmExit')}
            />
          </section>

          {isFiltering && !hasResults && (
            <p className="settings-empty" role="status" aria-live="polite">
              No settings match “{query.trim()}”.
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
