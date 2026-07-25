import { Puzzle } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceToggle } from './PreferenceToggle';

const PLUGINS = [
  ['wstack-chimera', 'settings:context.pluginChimera'],
  ['wstack-skills', 'settings:context.pluginSkills'],
  ['wstack-prompts', 'settings:context.pluginPrompts'],
  ['cost-tracker', 'settings:context.pluginCostTracker'],
  ['telegram', 'settings:context.pluginTelegram'],
  ['knowledge-graph', 'settings:context.pluginKnowledgeGraph'],
  ['error-lens', 'settings:context.pluginErrorLens'],
  ['todo-tracker', 'settings:context.pluginTodoTracker'],
  ['secret-scanner', 'settings:context.pluginSecretScanner'],
  ['lint-gate', 'settings:context.pluginLintGate'],
  ['diff-summary', 'settings:context.pluginDiffSummary'],
  ['dep-guard', 'settings:context.pluginDepGuard'],
  ['type-gate', 'settings:context.pluginTypeGate'],
  ['injection-shield', 'settings:context.pluginInjectionShield'],
  ['prompt-firewall', 'settings:context.pluginPromptFirewall'],
  ['token-budget', 'settings:context.pluginTokenBudget'],
  ['loop-breaker', 'settings:context.pluginLoopBreaker'],
] as const;

/** Renders the per-plugin enable/disable toggle list inside the Features tab. */
export function PluginToggleList() {
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
      {PLUGINS.map(([pluginName, labelKey]) => {
        const enabled = localPrefs.pluginsEnabled?.[pluginName] ?? true;
        return (
          <PreferenceToggle
            key={pluginName}
            label={t(labelKey)}
            value={enabled}
            onChange={() => {
              const next = { ...localPrefs.pluginsEnabled, [pluginName]: !enabled };
              localPrefs.set({ pluginsEnabled: next });
            }}
          />
        );
      })}
    </div>
  );
}
