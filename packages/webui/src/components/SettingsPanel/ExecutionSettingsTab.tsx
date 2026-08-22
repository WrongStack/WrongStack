import { CalendarClock, Shield, Zap } from 'lucide-react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { AvailabilityCalendarEditor } from '../AvailabilityCalendarEditor';
import { PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

export function ExecutionSettingsTab({
  syncPref,
  fallbackCandidates,
}: {
  syncPref: (key: string, value: unknown) => void;
  fallbackCandidates: ModelCandidate[];
}) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Zap className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:execution.heading')}</h3>
          </div>
        </div>
        <PreferenceSlider
          label={t('settings:execution.maxIterationsLabel')}
          hint={t('settings:execution.maxIterationsHint')}
          value={localPrefs.maxIterations}
          min={10}
          max={2000}
          step={10}
          onChange={(v) => syncPref('maxIterations', v)}
        />
        <PreferenceSlider
          label={t('settings:execution.autoProceedMaxIterationsLabel')}
          hint={t('settings:execution.autoProceedMaxIterationsHint')}
          value={localPrefs.autoProceedMaxIterations}
          min={0}
          max={250}
          step={5}
          onChange={(v) => syncPref('autoProceedMaxIterations', v)}
        />
        <PreferenceToggle
          label={t('settings:execution.confirmExitLabel')}
          hint={t('settings:execution.confirmExitHint')}
          value={localPrefs.confirmExit}
          onChange={() => syncPref('confirmExit', !localPrefs.confirmExit)}
        />
        <PreferenceToggle
          label={t('settings:execution.chimeLabel')}
          hint={t('settings:execution.chimeHint')}
          value={localPrefs.chime}
          onChange={() => syncPref('chime', !localPrefs.chime)}
        />
      </div>

      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-warning/20 bg-warning/10 text-warning">
            <Shield className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:execution.breakerLabel')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:execution.breakerHint')}
            </p>
          </div>
        </div>
        <PreferenceToggle
          label={t('settings:execution.breakerLabel')}
          hint={t('settings:execution.breakerHint')}
          value={localPrefs.breakerEnabled}
          onChange={() => syncPref('breakerEnabled', !localPrefs.breakerEnabled)}
        />
        <PreferenceSlider
          label={t('settings:execution.breakerTimeoutLabel')}
          hint={t('settings:execution.breakerTimeoutHint')}
          value={localPrefs.breakerAutoKillResetMs}
          min={0}
          max={60000}
          step={1000}
          unit="ms"
          onChange={(v) => syncPref('breakerAutoKillResetMs', v)}
        />
      </div>

      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <CalendarClock className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:execution.availabilityHeading')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:execution.availabilityHint')}
            </p>
          </div>
        </div>
        <AvailabilityCalendarEditor
          value={localPrefs.modelAvailabilitySchedule}
          candidates={fallbackCandidates}
          onChange={(next) => syncPref('modelAvailabilitySchedule', next)}
        />
      </div>
    </div>
  );
}
