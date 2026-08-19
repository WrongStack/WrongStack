import { Activity, Cpu, Zap } from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useSessionStore } from '@/stores/session-store';
import { ModelSelectDialog } from '../ModelSelectDialog';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

/** Canonical effort levels — shared shape with core's ReasoningEffort. */
const ALL_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
type Effort = (typeof ALL_EFFORTS)[number];
const EFFORT_SET: ReadonlySet<string> = new Set(ALL_EFFORTS);
/** Guard for server-supplied lists — anything outside the canonical enum
 *  would render a raw key as its label; filter it instead. */
function isEffort(value: string): value is Effort {
  return EFFORT_SET.has(value);
}

export function AgentSettingsTab({
  syncPref,
  switchAutonomy,
}: {
  syncPref: (key: string, value: unknown) => void;
  switchAutonomy: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => void;
}) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();
  const [refinerPickerOpen, setRefinerPickerOpen] = useState(false);

  // Effort levels advertised by the ACTIVE model (session.start payload).
  // Undefined until the server reports them — the full canonical set then
  // applies, matching the runtime resolver's conservative gate (unsupported
  // values are dropped with a warning, never rejected).
  const EFFORT_LABEL_KEYS: Record<Effort, string> = {
    none: 'settings:agent.reasoningEffortNone',
    minimal: 'settings:agent.reasoningEffortMinimal',
    low: 'settings:agent.reasoningEffortLow',
    medium: 'settings:agent.reasoningEffortMedium',
    high: 'settings:agent.reasoningEffortHigh',
    xhigh: 'settings:agent.reasoningEffortXhigh',
    max: 'settings:agent.reasoningEffortMax',
  };
  const effortLevels = useSessionStore((s) => s.reasoningEffortLevels);
  const narrowed = effortLevels?.length
    ? (effortLevels.filter(isEffort) as Effort[])
    : [...ALL_EFFORTS];
  // Desync guard: a persisted effort the model no longer advertises (set on
  // another model) would render an empty <select> — append it so the user
  // sees what is actually configured and can change it deliberately. The
  // runtime resolver independently drops unsupported values with a warning.
  const current = localPrefs.reasoningEffort;
  if (isEffort(current) && !narrowed.includes(current)) narrowed.push(current);
  const effortOptions = narrowed.map((level) => ({
    value: level,
    label: t(EFFORT_LABEL_KEYS[level]),
  }));

  return (
    <div className="space-y-6">
      {/* Autonomy & Behavior */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Activity className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:agent.autonomyHeading')}</h3>
          </div>
        </div>
        <PreferenceSelect
          label={t('settings:agent.autonomyModeLabel')}
          hint={t('settings:agent.autonomyModeHint')}
          value={localPrefs.autonomy}
          options={[
            { value: 'off' as const, label: t('settings:agent.autonomyModeOff') },
            { value: 'suggest' as const, label: t('settings:agent.autonomyModeSuggest') },
            { value: 'auto' as const, label: t('settings:agent.autonomyModeAuto') },
            { value: 'eternal' as const, label: t('settings:agent.autonomyModeEternal') },
            {
              value: 'eternal-parallel' as const,
              label: t('settings:agent.autonomyModeEternalParallel'),
            },
          ]}
          onChange={(v) => {
            localPrefs.set({ autonomy: v });
            switchAutonomy(v);
          }}
        />
        <PreferenceSlider
          label={t('settings:agent.autonomyDelayMsLabel')}
          hint={t('settings:agent.autonomyDelayMsHint')}
          value={localPrefs.autonomyDelayMs}
          min={0}
          max={10000}
          step={500}
          unit="ms"
          onChange={(v) => syncPref('autonomyDelayMs', v)}
        />
        <PreferenceToggle
          label={t('settings:agent.yoloLabel')}
          hint={t('settings:agent.yoloHint')}
          value={localPrefs.yolo}
          onChange={() => syncPref('yolo', !localPrefs.yolo)}
        />
      </div>

      {/* Prompt Refinement */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Zap className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:agent.refineHeading')}</h3>
          </div>
        </div>
        <PreferenceToggle
          label={t('settings:agent.enableRefineLabel')}
          hint={t('settings:agent.enableRefineHint')}
          value={localPrefs.enhanceEnabled}
          onChange={() => syncPref('enhanceEnabled', !localPrefs.enhanceEnabled)}
        />
        <PreferenceSlider
          label={t('settings:agent.refineDelayLabel')}
          hint={t('settings:agent.refineDelayHint')}
          value={localPrefs.enhanceDelayMs}
          min={30000}
          max={120000}
          step={15000}
          unit="ms"
          onChange={(v) => syncPref('enhanceDelayMs', v)}
        />
        <PreferenceSlider
          label={t('settings:agent.refineCountdownLabel')}
          hint={t('settings:agent.refineCountdownHint')}
          value={localPrefs.enhanceCountdownMs}
          min={1000}
          max={10000}
          step={1000}
          unit="ms"
          onChange={(v) => syncPref('enhanceCountdownMs', v)}
        />
        <PreferenceSelect
          label={t('settings:agent.refineLanguageLabel')}
          hint={t('settings:agent.refineLanguageHint')}
          value={localPrefs.enhanceLanguage}
          options={[
            {
              value: 'original' as const,
              label: t('settings:agent.refineLanguageOriginal'),
            },
            {
              value: 'english' as const,
              label: t('settings:agent.refineLanguageEnglish'),
            },
          ]}
          onChange={(v) => syncPref('enhanceLanguage', v)}
        />

        {/* Refiner config */}
        <div className="pt-3">
          <p className="text-sm font-medium mb-2">{t('settings:agent.refineHeading')}</p>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={() => setRefinerPickerOpen(true)}
          >
            <div className="min-w-0 flex-1">
              {localPrefs.refinerFallbackProfile ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                    {localPrefs.refinerFallbackProfile}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {(localPrefs.fallbackProfiles[localPrefs.refinerFallbackProfile] ?? [])
                      .slice(0, 2)
                      .join(' → ')}
                    {(localPrefs.fallbackProfiles[localPrefs.refinerFallbackProfile] ?? []).length > 2
                      ? ' …'
                      : ''}
                  </span>
                </div>
              ) : localPrefs.refinerProvider && localPrefs.refinerModel ? (
                <span className="text-xs font-mono">
                  {localPrefs.refinerProvider}/{localPrefs.refinerModel}
                </span>
              ) : localPrefs.refinerProvider ? (
                <span className="text-xs font-mono">
                  {localPrefs.refinerProvider} /{' '}
                  <span className="text-muted-foreground">{t('activity:index.sessionModel')}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('settings:agent.refinerProviderDefault')}
                </span>
              )}
            </div>
            <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </div>

        {refinerPickerOpen && (
          <ModelSelectDialog
            open={refinerPickerOpen}
            mode="both"
            title={t('settings:agent.refineHeading')}
            hint={t('settings:agent.refinerProviderHint')}
            fallbackProfiles={localPrefs.fallbackProfiles}
            clearLabel={t('common:action.clear')}
            onPick={(result) => {
              if (result.type === 'clear') {
                syncPref('refinerProvider', '');
                syncPref('refinerModel', '');
                syncPref('refinerFallbackProfile', '');
              } else if (result.type === 'provider-model') {
                syncPref('refinerProvider', result.provider);
                syncPref('refinerModel', result.model);
                syncPref('refinerFallbackProfile', '');
              } else if (result.type === 'fallback-profile') {
                syncPref('refinerProvider', '');
                syncPref('refinerModel', '');
                syncPref('refinerFallbackProfile', result.name);
              }
              setRefinerPickerOpen(false);
            }}
            onClose={() => setRefinerPickerOpen(false)}
          />
        )}
      </div>

      {/* Reasoning & Cache */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Cpu className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:agent.reasoningHeading')}</h3>
          </div>
        </div>
        <PreferenceSelect
          label={t('settings:agent.reasoningModeLabel')}
          hint={t('settings:agent.reasoningModeHint')}
          value={localPrefs.reasoningMode}
          options={[
            { value: 'auto' as const, label: t('settings:agent.reasoningModeAuto') },
            { value: 'on' as const, label: t('settings:agent.reasoningModeOn') },
            { value: 'off' as const, label: t('settings:agent.reasoningModeOff') },
          ]}
          onChange={(v) => syncPref('reasoningMode', v)}
        />
        <PreferenceSelect
          label={t('settings:agent.reasoningEffortLabel')}
          hint={
            effortLevels
              ? `${t('settings:agent.reasoningEffortHint')} (${t('settings:agent.reasoningEffortModelSet')})`
              : t('settings:agent.reasoningEffortHint')
          }
          value={localPrefs.reasoningEffort}
          options={effortOptions}
          onChange={(v) => syncPref('reasoningEffort', v)}
        />
        <PreferenceToggle
          label={t('settings:agent.preserveThinkingLabel')}
          hint={t('settings:agent.preserveThinkingHint')}
          value={localPrefs.reasoningPreserve}
          onChange={() => syncPref('reasoningPreserve', !localPrefs.reasoningPreserve)}
        />
        <PreferenceSelect
          label={t('settings:agent.cacheTtlLabel')}
          hint={t('settings:agent.cacheTtlHint')}
          value={localPrefs.cacheTtl}
          options={[
            { value: 'default' as const, label: t('settings:agent.cacheTtlDefault') },
            { value: '5m' as const, label: t('settings:agent.cacheTtl5m') },
            { value: '1h' as const, label: t('settings:agent.cacheTtl1h') },
          ]}
          onChange={(v) => syncPref('cacheTtl', v)}
        />
        <p className="text-xs text-muted-foreground mt-2">{t('settings:agent.capsHint')}</p>
      </div>
    </div>
  );
}
