import { Bug } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceSelect } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

export function LogsSettingsTab({ syncPref }: { syncPref: (key: string, value: unknown) => void }) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Bug className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:logs.heading')}</h3>
          </div>
        </div>
        <PreferenceSelect
          label={t('settings:logs.logLevelLabel')}
          hint={t('settings:logs.logLevelHint')}
          value={localPrefs.logLevel}
          options={[
            { value: 'debug' as const, label: t('settings:logs.logLevelDebug') },
            { value: 'info' as const, label: t('settings:logs.logLevelInfo') },
            { value: 'warn' as const, label: t('settings:logs.logLevelWarn') },
            { value: 'error' as const, label: t('settings:logs.logLevelError') },
          ]}
          onChange={(v) => syncPref('logLevel', v)}
        />
        <PreferenceSelect
          label={t('settings:logs.auditLevelLabel')}
          hint={t('settings:logs.auditLevelHint')}
          value={localPrefs.auditLevel}
          options={[
            { value: 'minimal' as const, label: t('settings:logs.auditLevelMinimal') },
            { value: 'standard' as const, label: t('settings:logs.auditLevelStandard') },
            { value: 'full' as const, label: t('settings:logs.auditLevelFull') },
          ]}
          onChange={(v) => syncPref('auditLevel', v)}
        />
        <PreferenceSelect
          label={t('settings:logs.fsAccessLabel')}
          hint={t('settings:logs.fsAccessHint')}
          value={localPrefs.fsAccess}
          options={[
            {
              value: 'unrestricted' as const,
              label: t('settings:logs.fsAccessUnrestricted'),
            },
            { value: 'project' as const, label: t('settings:logs.fsAccessProject') },
          ]}
          onChange={(v) => syncPref('fsAccess', v)}
        />
        <PreferenceToggle
          label={t('settings:logs.debugStreamLabel')}
          hint={t('settings:logs.debugStreamHint')}
          value={localPrefs.debugStream}
          onChange={() => syncPref('debugStream', !localPrefs.debugStream)}
        />
      </div>
    </div>
  );
}
