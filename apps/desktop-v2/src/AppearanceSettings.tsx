import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { accentThemes } from './appearance';
import type { DesktopController } from './useDesktop';

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
      <div className="settings-host">
        <span className={`status-dot ${vm.connected ? 'running' : 'stopped'}`} />
        <span>{vm.connected ? 'Local workspace connected' : 'Connecting to your workspace'}</span>
        <small>Sessions keep running when you close a window.</small>
      </div>
    </section>
  );
}
