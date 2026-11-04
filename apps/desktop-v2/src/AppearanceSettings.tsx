import { playCompletionChime } from '@wrongstack/project-surfaces/lib/chime';
import { LANGUAGES } from '@wrongstack/project-surfaces/lib/languages';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { accentThemes } from './appearance';
import { useDesktopText } from './desktop-i18n';
import { SurfaceLanguageSync } from './SurfaceLanguageSync';
import { displayLanguage } from './surface-i18n';
import type { DesktopController } from './useDesktop';
import { useProfileEngine } from './useEngine';

/**
 * The display language the profile shares with the WebUI and CLI (`Config.uiLocale`). Names are
 * each language's own, so anyone can find theirs whatever is shown now.
 */
function DisplayLanguage({ reportError }: { reportError: (error: unknown) => void }) {
  const { t } = useDesktopText();
  const { state, command } = useProfileEngine(reportError);
  const [busy, setBusy] = useState(false);
  const current = displayLanguage(state.results['prefs.updated']);
  return (
    <div className="appearance-section">
      <SurfaceLanguageSync />
      <div>
        <h3>{t('appearance.language.title')}</h3>
        <p>{t('appearance.language.body')}</p>
      </div>
      <select
        className="display-language"
        aria-label={t('appearance.language.title')}
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
  const { t } = useDesktopText();
  const { appearance, changeAppearance } = vm;
  return (
    <section className="appearance-settings" aria-label={t('appearance.label')}>
      <div className="appearance-section">
        <div>
          <h3>{t('rail.appearance')}</h3>
          <p>{t('appearance.body')}</p>
        </div>
        <fieldset className="appearance-modes" aria-label={t('appearance.colorMode')}>
          {(
            [
              { id: 'system', label: t('appearance.mode.system'), Icon: Monitor },
              { id: 'light', label: t('appearance.mode.light'), Icon: Sun },
              { id: 'dark', label: t('appearance.mode.dark'), Icon: Moon },
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
          <h3>{t('appearance.contrast.title')}</h3>
          <p>{t('appearance.contrast.body')}</p>
        </div>
        <fieldset className="appearance-modes" aria-label="Contrast">
          {(
            [
              { id: 'system', label: t('appearance.contrast.system') },
              { id: 'standard', label: t('appearance.contrast.standard') },
              { id: 'more', label: t('appearance.contrast.more') },
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
          <h3>{t('appearance.density.title')}</h3>
          <p>{t('appearance.density.body')}</p>
        </div>
        <fieldset className="appearance-modes" aria-label={t('appearance.density.title')}>
          {(
            [
              { id: undefined, label: t('appearance.density.comfortable') },
              { id: 'compact', label: t('appearance.density.compact') },
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
          <h3>{t('appearance.sounds.title')}</h3>
          <p>{t('appearance.sounds.body')}</p>
        </div>
        <fieldset className="appearance-modes" aria-label={t('appearance.sounds.label')}>
          {(
            [
              { id: undefined, label: t('appearance.sounds.off') },
              { id: 'on', label: t('appearance.sounds.on') },
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
          <h3>{t('appearance.palette.title')}</h3>
          <p>{t('appearance.palette.body')}</p>
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
        <span>{t(vm.connected ? 'appearance.host.connected' : 'appearance.host.connecting')}</span>
        <small>{t('appearance.host.note')}</small>
      </div>
    </section>
  );
}
