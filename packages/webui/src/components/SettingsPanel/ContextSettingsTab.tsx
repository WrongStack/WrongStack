import { FileText } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PluginToggleList } from './PluginToggleList';
import { PreferenceSelect } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

export function ContextSettingsTab({
  syncPref,
}: {
  syncPref: (key: string, value: unknown) => void;
}) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="space-y-6">
      {/* Feature Flags */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <FileText className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:context.flagsHeading')}</h3>
          </div>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          <PreferenceToggle
            label={t('settings:context.mcpLabel')}
            hint={t('settings:context.mcpHint')}
            value={localPrefs.featureMcp}
            onChange={() => syncPref('featureMcp', !localPrefs.featureMcp)}
          />
          <PreferenceToggle
            label={t('settings:context.pluginsLabel')}
            hint={t('settings:context.pluginsHint')}
            value={localPrefs.featurePlugins}
            onChange={() => syncPref('featurePlugins', !localPrefs.featurePlugins)}
          />
          <PreferenceToggle
            label={t('settings:context.memoryLabel')}
            hint={t('settings:context.memoryHint')}
            value={localPrefs.featureMemory}
            onChange={() => syncPref('featureMemory', !localPrefs.featureMemory)}
          />
          <PreferenceToggle
            label={t('settings:context.skillsLabel')}
            hint={t('settings:context.skillsHint')}
            value={localPrefs.featureSkills}
            onChange={() => syncPref('featureSkills', !localPrefs.featureSkills)}
          />
          <PreferenceToggle
            label={t('settings:context.modelsRegistryLabel')}
            hint={t('settings:context.modelsRegistryHint')}
            value={localPrefs.featureModelsRegistry}
            onChange={() => syncPref('featureModelsRegistry', !localPrefs.featureModelsRegistry)}
          />
          <PreferenceToggle
            label={t('settings:context.indexOnStartLabel')}
            hint={t('settings:context.indexOnStartHint')}
            value={localPrefs.indexOnStart}
            onChange={() => syncPref('indexOnStart', !localPrefs.indexOnStart)}
          />
        </div>
      </div>

      {/* Context Strategy & Compactor */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <FileText className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">
              {t('settings:context.compactorStrategyLabel')}
            </h3>
          </div>
        </div>
        <PreferenceToggle
          label={t('settings:context.autoCompactLabel')}
          hint={t('settings:context.autoCompactHint')}
          value={localPrefs.contextAutoCompact}
          onChange={() => syncPref('contextAutoCompact', !localPrefs.contextAutoCompact)}
        />
        <PreferenceSelect
          label={t('settings:context.compactorStrategyLabel')}
          hint={t('settings:context.compactorStrategyHint')}
          value={localPrefs.contextStrategy}
          options={[
            {
              value: 'hybrid' as const,
              label: t('settings:context.compactorStrategyHybrid'),
            },
            {
              value: 'intelligent' as const,
              label: t('settings:context.compactorStrategyIntelligent'),
            },
            {
              value: 'selective' as const,
              label: t('settings:context.compactorStrategySelective'),
            },
          ]}
          onChange={(v) => syncPref('contextStrategy', v)}
        />
        <PreferenceSelect
          label={t('settings:context.contextModeLabel')}
          hint={t('settings:context.contextModeHint')}
          value={localPrefs.contextMode}
          options={[
            {
              value: 'balanced' as const,
              label: t('settings:context.contextModeBalanced'),
            },
            { value: 'frugal' as const, label: t('settings:context.contextModeFrugal') },
            { value: 'deep' as const, label: t('settings:context.contextModeDeep') },
          ]}
          onChange={(v) => syncPref('contextMode', v)}
        />
        <PreferenceSelect
          label={t('settings:context.tokenSavingLabel')}
          hint={t('settings:context.tokenSavingHint')}
          value={localPrefs.tokenSavingTier}
          options={[
            { value: 'auto' as const, label: t('settings:context.tokenSavingAuto') },
            { value: 'off' as const, label: t('settings:context.tokenSavingOff') },
            {
              value: 'minimal' as const,
              label: t('settings:context.tokenSavingMinimal'),
            },
            { value: 'light' as const, label: t('settings:context.tokenSavingLight') },
            { value: 'medium' as const, label: t('settings:context.tokenSavingMedium') },
            {
              value: 'aggressive' as const,
              label: t('settings:context.tokenSavingAggressive'),
            },
          ]}
          onChange={(v) => syncPref('tokenSavingTier', v)}
        />
      </div>

      {/* Per-Plugin Toggle List */}
      <PluginToggleList syncPref={syncPref} />
    </div>
  );
}
