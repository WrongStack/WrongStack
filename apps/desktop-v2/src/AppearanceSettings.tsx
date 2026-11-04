import { playCompletionChime } from '@wrongstack/project-surfaces/lib/chime';
import { LANGUAGES } from '@wrongstack/project-surfaces/lib/languages';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { accentThemes } from './appearance';
import { SurfaceLanguageSync } from './SurfaceLanguageSync';
import { displayLanguage } from './surface-i18n';
import type { DesktopController } from './useDesktop';
import { useProfileEngine } from './useEngine';

/**
 * The display language the profile shares with the WebUI and CLI (`Config.uiLocale`). Names are
 * each language's own, so anyone can find theirs whatever is shown now.
 */
function DisplayLanguage({ reportError }: { reportError: (error: unknown) => void }) {
  const { state, command } = useProfileEngine(reportError);
  const [busy, setBusy] = useState(false);
  const current = displayLanguage(state.results['prefs.updated']);
  return (
    <div className="appearance-section">
      <SurfaceLanguageSync />
      <div>
        <h3>Display language</h3>
        <p>
          Shared with the WebUI and CLI. The pages shared with the WebUI (memory, Kanban, Code
          Atlas, the office, session story, dashboards and setup) follow it; the rest of the desktop
          is in English for now.
        </p>
      </div>
      <select
        className="display-language"
        aria-label="Display language"
        value={current}
        disabled={!state.connected || busy}
        onChange={(event) => {
          setBusy(true);
          void command('prefs.update', { uiLocale: event.target.value }, ['key.operation_result'])
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
      >
        {LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AppearanceSettings({ vm }: { vm: DesktopController }) {
  const { appearance, changeAppearance } = vm;
  return (
    <section className="appearance-settings" aria-label="Appearance settings">
      <div className="appearance-section">
        <div>
          <h3>Appearance</h3>
          <p>Follow your device, or choose a mode.</p>
        </div>
        <fieldset className="appearance-modes" aria-label="Color mode">
          {(
            [
              { id: 'system', label: 'System', Icon: Monitor },
              { id: 'light', label: 'Light', Icon: Sun },
              { id: 'dark', label: 'Dark', Icon: Moon },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              type="button"
              key={id}
              aria-pressed={appearance.mode === id}
              onClick={() => changeAppearance({ mode: id })}
            >
              <Icon size={19} />
              <span>{label}</span>
              {appearance.mode === id && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance-section">
        <div>
          <h3>Contrast</h3>
          <p>Stronger text, borders and focus outlines; System follows your device setting.</p>
        </div>
        <fieldset className="appearance-modes" aria-label="Contrast">
          {(
            [
              { id: 'system', label: 'System' },
              { id: 'standard', label: 'Standard' },
              { id: 'more', label: 'High' },
            ] as const
          ).map(({ id, label }) => (
            <button
              type="button"
              key={id}
              aria-pressed={appearance.contrast === id}
              onClick={() => changeAppearance({ contrast: id })}
            >
              <span>{label}</span>
              {appearance.contrast === id && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance-section">
        <div>
          <h3>Conversation density</h3>
          <p>Compact puts more of a conversation on screen, as the WebUI's compact view does.</p>
        </div>
        <fieldset className="appearance-modes" aria-label="Conversation density">
          {(
            [
              { id: undefined, label: 'Comfortable' },
              { id: 'compact', label: 'Compact' },
            ] as const
          ).map(({ id, label }) => (
            <button
              type="button"
              key={label}
              aria-pressed={appearance.density === id}
              onClick={() => changeAppearance({ density: id })}
            >
              <span>{label}</span>
              {appearance.density === id && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance-section">
        <div>
          <h3>Sounds</h3>
          <p>
            A soft chime when a run in the open conversation finishes. A request for your approval
            always chimes, as in the WebUI.
          </p>
        </div>
        <fieldset className="appearance-modes" aria-label="Sound when a run finishes">
          {(
            [
              { id: undefined, label: 'Off' },
              { id: 'on', label: 'Chime when done' },
            ] as const
          ).map(({ id, label }) => (
            <button
              type="button"
              key={label}
              aria-pressed={appearance.sound === id}
              onClick={() => {
                changeAppearance({ sound: id });
                if (id) playCompletionChime();
              }}
            >
              <span>{label}</span>
              {appearance.sound === id && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance-section">
        <div>
          <h3>Color palette</h3>
          <p>WrongStack’s signature color pairs, tuned for light and dark.</p>
        </div>
        <div className="theme-choices">
          {accentThemes.map((theme) => (
            <button
              type="button"
              key={theme.id}
              aria-pressed={appearance.accent === theme.id}
              onClick={() => changeAppearance({ accent: theme.id })}
            >
              <span
                className="theme-pair"
                aria-hidden="true"
                style={
                  {
                    '--swatch': theme.color,
                    '--swatch-secondary': theme.secondaryColor,
                  } as React.CSSProperties
                }
              >
                <i />
                <i />
              </span>
              <span className="theme-label">
                <strong>{theme.name}</strong>
                {appearance.accent === theme.id && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      </div>
      <DisplayLanguage reportError={vm.reportError} />
      <div className="settings-host">
        <span className={`status-dot ${vm.connected ? 'running' : 'stopped'}`} />
        <span>{vm.connected ? 'Local workspace connected' : 'Connecting to your workspace'}</span>
        <small>Sessions keep running when you close a window.</small>
      </div>
    </section>
  );
}
