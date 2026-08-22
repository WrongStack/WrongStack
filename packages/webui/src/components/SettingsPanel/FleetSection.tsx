import { Layers } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

interface FleetSectionProps {
  /** Push a pref change locally + to the server. */
  syncPref: (key: string, value: unknown) => void;
}

export function FleetSection({ syncPref }: FleetSectionProps) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Layers className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:fleet.heading')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('activity:fleetSection.configureHowSubagentsAndFleetOperations')}
            </p>
          </div>
        </div>

        <div className="space-y-1 divide-y divide-border/50">
          <div className="pb-3">
            <PreferenceToggle
              label={t('settings:fleet.fleetChatVerbosityLabel')}
              hint={t('settings:fleet.fleetChatVerbosityHint')}
              value={localPrefs.fleetChatVerbosity !== 'off'}
              onChange={() =>
                syncPref(
                  'fleetChatVerbosity',
                  localPrefs.fleetChatVerbosity === 'off' ? 'full' : 'off',
                )
              }
            />
          </div>

          <div className="py-3">
            <PreferenceSlider
              label={t('settings:fleet.maxConcurrentLabel')}
              hint={t('settings:fleet.maxConcurrentHint')}
              value={localPrefs.maxConcurrent}
              min={1}
              max={50}
              step={1}
              onChange={(v) => syncPref('maxConcurrent', v)}
            />
          </div>

          <div className="py-3">
            <PreferenceToggle
              label={t('settings:fleet.nextPredictionLabel')}
              hint={t('settings:fleet.nextPredictionHint')}
              value={localPrefs.nextPrediction}
              onChange={() => syncPref('nextPrediction', !localPrefs.nextPrediction)}
            />
          </div>

          <div className="pt-3">
            <PreferenceToggle
              label={t('settings:fleet.nextStepsToolLabel')}
              hint={t('settings:fleet.nextStepsToolHint')}
              value={localPrefs.nextStepsTool}
              onChange={() => syncPref('nextStepsTool', !localPrefs.nextStepsTool)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
