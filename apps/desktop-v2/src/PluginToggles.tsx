import { PLUGIN_AUDIT_ENTRIES } from '@wrongstack/plugins/plugin-audit-catalog';
import { Puzzle } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';

/** A plugin's readable name: the catalog id without its scope or `wstack-` prefix, in words. */
function pluginLabel(name: string) {
  return name
    .replace(/^@wrongstack\//, '')
    .replace(/^wstack-/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const PLUGINS = [...PLUGIN_AUDIT_ENTRIES].sort((a, b) =>
  pluginLabel(a.name).localeCompare(pluginLabel(b.name)),
);

/**
 * Turns individual plugins on or off, as the WebUI's per-plugin controls do. The list is the
 * plugin catalog the CLI's plugin manager uses, so inactive plugins appear too. A plugin the
 * profile decides shows the engine's effective state; others show the catalog default. Saving
 * writes `pluginsEnabled`; plugins that cannot be disabled are locked.
 */
export function PluginToggles({
  draft,
  change,
}: {
  draft: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
}) {
  const { t } = useDesktopText();
  const [query, setQuery] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const decided =
    draft['pluginsEnabled'] && typeof draft['pluginsEnabled'] === 'object'
      ? (draft['pluginsEnabled'] as Record<string, unknown>)
      : {};
  const enabled = (entry: (typeof PLUGINS)[number]) =>
    typeof decided[entry.name] === 'boolean'
      ? decided[entry.name] === true
      : entry.defaultState === 'active';
  const needle = query.trim().toLocaleLowerCase();
  const visible = PLUGINS.filter(
    (entry) =>
      (!enabledOnly || enabled(entry)) &&
      (!needle ||
        [entry.name, pluginLabel(entry.name), entry.summary].some((text) =>
          text.toLocaleLowerCase().includes(needle),
        )),
  );
  return (
    <section className="plugin-toggles" aria-label={t('pluginToggles.title')}>
      <h3>
        <Puzzle size={15} /> {t('pluginToggles.title')}
      </h3>
      <p className="field-help">{t('pluginToggles.intro')}</p>
      <div className="plugin-toggle-filters">
        <input
          type="search"
          aria-label={t('pluginToggles.search')}
          placeholder={t('pluginToggles.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="button secondary small"
          aria-pressed={enabledOnly}
          onClick={() => setEnabledOnly((value) => !value)}
        >
          {t('pluginToggles.enabledOnly')}
        </button>
        <span className="plugin-toggle-count" aria-live="polite">
          {visible.length} / {PLUGINS.length}
        </span>
      </div>
      {visible.length === 0 && <p className="field-help">{t('pluginToggles.noMatch')}</p>}
      {visible.map((entry) => {
        const on = enabled(entry);
        return (
          <div className="setting-row setting-toggle" key={entry.name}>
            <div>
              <label htmlFor={`plugin-${entry.name}`}>{pluginLabel(entry.name)}</label>
              <p>{entry.summary}</p>
              {!entry.canDisable && <small>{t('pluginToggles.alwaysOn')}</small>}
            </div>
            <div className="setting-control">
              <button
                type="button"
                id={`plugin-${entry.name}`}
                role="switch"
                aria-checked={on}
                aria-label={pluginLabel(entry.name)}
                className="settings-switch"
                disabled={!entry.canDisable}
                onClick={() => change('pluginsEnabled', { ...decided, [entry.name]: !on })}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
