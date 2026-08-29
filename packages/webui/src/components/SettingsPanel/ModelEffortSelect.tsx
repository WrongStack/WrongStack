import { useAppTranslation } from '@/i18n';
import {
  EFFORT_LABEL_KEYS,
  effortLabelKey,
  effortNotAdvertised,
  resolveEffortOptions,
} from '@/lib/reasoning-effort';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useSessionStore } from '@/stores/session-store';
import { PreferenceSelect } from './PreferenceControls';

/**
 * Per-session reasoning effort, shown next to the model selection in the
 * Settings model tab. Options narrow to the levels the ACTIVE model
 * documents (session snapshot payload); an undocumented vocabulary offers
 * the full canonical set, matching the runtime resolver's conservative gate.
 * Writes the session-scoped reasoningEffort pref via the same syncPref trip
 * as the rest of this panel (local set + prefs.update).
 */
export function ModelEffortSelect({
  syncPref,
}: {
  syncPref: (key: string, value: unknown) => void;
}) {
  const { t } = useAppTranslation();
  const reasoningEffort = useLocalPrefs((s) => s.reasoningEffort);
  const effortLevels = useSessionStore((s) => s.reasoningEffortLevels);
  const effortOptions = resolveEffortOptions(effortLevels, reasoningEffort).map((level) => ({
    value: level,
    label: t(effortLabelKey(level)),
  }));

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <PreferenceSelect
        label={t('settings:agent.reasoningEffortLabel')}
        hint={
          effortNotAdvertised(effortLevels, reasoningEffort)
            ? t('settings:agent.reasoningEffortUnsupported', {
                levels: (effortLevels ?? []).join(', '),
              })
            : effortLevels
              ? `${t('settings:agent.reasoningEffortHint')} (${t('settings:agent.reasoningEffortModelSet')})`
              : t('settings:agent.reasoningEffortHint')
        }
        value={reasoningEffort}
        options={effortOptions}
        onChange={(v) => syncPref('reasoningEffort', v)}
      />
    </div>
  );
}
