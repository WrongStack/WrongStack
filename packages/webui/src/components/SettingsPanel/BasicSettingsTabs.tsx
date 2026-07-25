import { Globe, Monitor, Moon, Sun } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, LANGUAGES, useAppTranslation } from '@/i18n';
import { useConfigStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useTheme } from '../ThemeProvider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { TabsContent } from '../ui/tabs';
import { PreferenceSelect } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

export function ConnectionSettingsTab() {
  const { t } = useAppTranslation();
  const { wsUrl, setConfig } = useConfigStore(
    useShallow((state) => ({ wsUrl: state.wsUrl, setConfig: state.setConfig })),
  );

  return (
    <div className="mt-0 space-y-4">
      <div className="space-y-3">
        <label htmlFor="websocket-url" className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t('settings:connection.wsUrlLabel')}
        </label>
        <Input
          id="websocket-url"
          value={wsUrl}
          onChange={(event) => setConfig({ wsUrl: event.target.value })}
          placeholder={t('settings:connection.wsUrlPlaceholder')}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">{t('settings:connection.wsUrlHint')}</p>
      </div>

      <div className="p-4 rounded-lg border bg-muted/50">
        <h4 className="text-sm font-medium mb-2">{t('settings:connection.startingHeading')}</h4>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings:connection.startingBody')}
        </p>
      </div>
    </div>
  );
}

export function AppearanceSettingsTab() {
  const { t } = useAppTranslation();
  const { theme, setTheme } = useTheme();
  const { updatePrefs } = useWebSocket();
  const localPrefs = useLocalPrefs();
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );
  const setUiLocale = useCallback(
    (code: string) => {
      localPrefs.set({ uiLocale: code });
      if (i18n.language !== code) void i18n.changeLanguage(code);
      syncPref('uiLocale', code);
    },
    [localPrefs, syncPref],
  );

  return (
    <div className="mt-0 space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-3">{t('settings:general.themeHeading')}</h3>
        <div className="grid grid-cols-3 gap-2 max-w-md">
          <Button
            variant={theme === 'light' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('light')}
          >
            <Sun className="h-4 w-4 mr-1" />
            {t('settings:general.themeLight')}
          </Button>
          <Button
            variant={theme === 'dark' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('dark')}
          >
            <Moon className="h-4 w-4 mr-1" />
            {t('settings:general.themeDark')}
          </Button>
          <Button
            variant={theme === 'system' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTheme('system')}
          >
            <Monitor className="h-4 w-4 mr-1" />
            {t('settings:general.themeSystem')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {t('settings:general.themeSystemHint')}
        </p>
      </div>

      <div className="pt-2 border-t">
        <h3 className="text-sm font-semibold mb-3 mt-3">
          {t('settings:general.languageHeading')}
        </h3>
        <PreferenceSelect
          label={t('settings:general.languageLabel')}
          hint={t('settings:general.languageHint')}
          value={localPrefs.uiLocale}
          options={LANGUAGES.map((language) => ({ value: language.code, label: language.name }))}
          onChange={setUiLocale}
        />
      </div>

      <div className="pt-2 border-t">
        <h3 className="text-sm font-semibold mb-3 mt-3">
          {t('settings:general.preferencesHeading')}
        </h3>
        <PreferenceToggle
          label={t('settings:general.compactDensity')}
          hint={t('settings:general.compactDensityHint')}
          selector={(state) => state.compactMode}
          onChange={() => useUIStore.getState().toggleCompactMode()}
        />
        <PreferenceToggle
          label={t('settings:general.soundOnComplete')}
          hint={t('settings:general.soundOnCompleteHint')}
          selector={null}
          configKey="soundOnComplete"
        />
        <PreferenceToggle
          label={t('settings:general.titleAnimation')}
          hint={t('settings:general.titleAnimationHint')}
          value={localPrefs.titleAnimation}
          onChange={() => syncPref('titleAnimation', !localPrefs.titleAnimation)}
        />
        <PreferenceToggle
          label={t('settings:general.showThinkingLabel')}
          hint={t('settings:general.showThinkingHint')}
          value={localPrefs.showThinkingLogs}
          onChange={() => syncPref('showThinkingLogs', !localPrefs.showThinkingLogs)}
        />
        <PreferenceToggle
          label={t('settings:general.groupToolCallsLabel')}
          hint={t('settings:general.groupToolCallsHint')}
          value={localPrefs.groupToolCalls}
          onChange={() => syncPref('groupToolCalls', !localPrefs.groupToolCalls)}
        />
      </div>
    </div>
  );
}
