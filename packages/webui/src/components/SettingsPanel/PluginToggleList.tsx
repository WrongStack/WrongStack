import { PLUGIN_AUDIT_ENTRIES } from '@wrongstack/plugins/plugin-audit-catalog';
import { Puzzle } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceToggle } from './PreferenceToggle';

/**
 * Curated, localized display labels for the plugins that pre-date the
 * data-driven catalog. Plugins not listed here fall back to a name-derived
 * label (see `displayName`) plus their catalog `summary` as the hint, so the
 * list stays complete without needing a translation key per plugin.
 */
const PLUGIN_LABEL_KEYS: Record<string, string> = {
  'wstack-chimera': 'settings:context.pluginChimera',
  'wstack-skills': 'settings:context.pluginSkills',
  'wstack-prompts': 'settings:context.pluginPrompts',
  'cost-tracker': 'settings:context.pluginCostTracker',
  telegram: 'settings:context.pluginTelegram',
  'knowledge-graph': 'settings:context.pluginKnowledgeGraph',
  'error-lens': 'settings:context.pluginErrorLens',
  'todo-tracker': 'settings:context.pluginTodoTracker',
  'secret-scanner': 'settings:context.pluginSecretScanner',
  'lint-gate': 'settings:context.pluginLintGate',
  'diff-summary': 'settings:context.pluginDiffSummary',
  'dep-guard': 'settings:context.pluginDepGuard',
  'type-gate': 'settings:context.pluginTypeGate',
  'injection-shield': 'settings:context.pluginInjectionShield',
  'prompt-firewall': 'settings:context.pluginPromptFirewall',
  'token-budget': 'settings:context.pluginTokenBudget',
  'loop-breaker': 'settings:context.pluginLoopBreaker',
};

/** Human-readable fallback label for plugins without a curated i18n key. */
function displayName(name: string): string {
  const bare = name.replace(/^@wrongstack\//, '').replace(/^wstack-/, '');
  return bare
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// The catalog is a frozen, build-time constant, so sort it once at module
// scope rather than on every render. Alphabetical by display label keeps the
// ~70-entry list navigable.
const SORTED_PLUGINS = [...PLUGIN_AUDIT_ENTRIES].sort((a, b) =>
  displayName(a.name).localeCompare(displayName(b.name)),
);

/**
 * Renders the per-plugin enable/disable toggle list inside the Features tab.
 *
 * The list is driven by the shared audit catalog (`@wrongstack/plugins/
 * plugin-audit-catalog`) — the same single source of truth the CLI plugin
 * manager uses — so EVERY plugin the host knows about appears here, whether
 * it is currently active or inactive.
 *
 * `localPrefs.pluginsEnabled` is NOT just this browser's memory: on connect the
 * server seeds it (context-meta.ts) with the EFFECTIVE state resolved through
 * core's shared precedence, and the snapshot wins over localStorage. So a
 * plugin the config decides shows what is actually running; only plugins the
 * config says nothing about fall back to the catalog `defaultState` here.
 *
 * On write the server projects the toggle onto `extensions.<name>.enabled` AND
 * any matching `config.plugins` entry (pref-helpers.ts) — the entry outranks
 * the extension, so writing only the latter made this switch decorative.
 * Plugins flagged `canDisable: false` render a locked, non-interactive switch.
 */
export function PluginToggleList({
  syncPref,
}: {
  syncPref?: ((key: string, value: unknown) => void) | undefined;
} = {}) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="pt-2 border-t">
      <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        {t('settings:context.pluginsPerPluginHeading')}
      </h3>
      <p className="text-xs text-muted-foreground mb-2">
        {t('settings:context.pluginsPerPluginHint')}
      </p>
      {SORTED_PLUGINS.map((entry) => {
        const labelKey = PLUGIN_LABEL_KEYS[entry.name];
        const label = labelKey ? t(labelKey) : displayName(entry.name);
        const enabled = localPrefs.pluginsEnabled?.[entry.name] ?? entry.defaultState === 'active';
        return (
          <PreferenceToggle
            key={entry.name}
            label={label}
            hint={entry.summary}
            value={enabled}
            disabled={!entry.canDisable}
            onChange={() => {
              const next = { ...localPrefs.pluginsEnabled, [entry.name]: !enabled };
              localPrefs.set({ pluginsEnabled: next });
              syncPref?.('pluginsEnabled', next);
            }}
          />
        );
      })}
    </div>
  );
}
