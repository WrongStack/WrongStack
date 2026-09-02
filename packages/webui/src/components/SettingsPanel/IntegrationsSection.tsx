import { Send, Server } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { MCPSection } from './MCPSection';
import { PreferenceToggle } from './PreferenceToggle';

interface IntegrationsSectionProps {
  /** Push a pref change locally + to the server. */
  syncPref: (key: string, value: unknown) => void;
}

export function IntegrationsSection({ syncPref }: IntegrationsSectionProps) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  return (
    <div className="space-y-6">
      {/* WrongProxy / WrongTrace — automatic base-URL rerouting */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Server className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">
              {t('settings:integrations.wrongProxyHeading')}
            </h3>
          </div>
        </div>
        <div className="space-y-3">
          <PreferenceToggle
            label={t('settings:integrations.wrongProxyEnabledLabel')}
            hint={t('settings:integrations.wrongProxyEnabledHint')}
            value={localPrefs.wrongProxyEnabled}
            onChange={() => syncPref('wrongProxyEnabled', !localPrefs.wrongProxyEnabled)}
          />
          <div className="space-y-1">
            <span className="text-sm font-medium">
              {t('settings:integrations.wrongProxyUrlLabel')}
            </span>
            <Input
              value={localPrefs.wrongProxyUrl}
              placeholder="http://localhost:3444"
              onChange={(e) => syncPref('wrongProxyUrl', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings:integrations.wrongProxyUrlHint')}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('settings:integrations.wrongProxyChangesApply')}
          </p>
        </div>
      </div>

      {/* HQ Client */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Server className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:integrations.hqHeading')}</h3>
          </div>
        </div>
        <div className="space-y-3">
          <PreferenceToggle
            label={t('settings:integrations.hqPublishingLabel')}
            hint={t('settings:integrations.hqPublishingHint')}
            value={localPrefs.hqEnabled}
            onChange={() => syncPref('hqEnabled', !localPrefs.hqEnabled)}
          />
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('settings:integrations.hqUrlLabel')}</span>
            <Input
              value={localPrefs.hqUrl}
              placeholder={t('activity:integrationsSection.httpHost3499')}
              onChange={(e) => syncPref('hqUrl', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('settings:integrations.hqUrlHint')}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('settings:integrations.hqTokenLabel')}</span>
            <Input
              type="password"
              value={localPrefs.hqToken}
              placeholder={t('activity:integrationsSection.clientTokenFromWstackHq')}
              onChange={(e) => syncPref('hqToken', e.target.value)}
            />
          </div>
          <PreferenceToggle
            label={t('settings:integrations.hqRawContentLabel')}
            hint={t('settings:integrations.hqRawContentHint')}
            value={localPrefs.hqRawContent}
            onChange={() => syncPref('hqRawContent', !localPrefs.hqRawContent)}
          />
        </div>
      </div>

      {/* MCP Servers */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Server className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">
              {t('activity:integrationsSection.mcpServers')}
            </h3>
          </div>
        </div>
        {!localPrefs.featureMcp ? (
          <div className="text-center py-6 text-muted-foreground">
            <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('settings:mcp.disabled')}</p>
            <p className="text-xs mt-1">{t('settings:integrations.disabledHint')}</p>
          </div>
        ) : (
          <MCPSection />
        )}
      </div>

      {/* Telegram Notifications */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Send className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:integrations.telegramHeading')}</h3>
          </div>
        </div>
        {localPrefs.tgConfigured ? (
          <div className="space-y-3">
            <PreferenceToggle
              label={t('settings:integrations.telegramSessionEndLabel')}
              hint={t('settings:integrations.telegramSessionEndHint')}
              value={localPrefs.tgSessionEnd}
              onChange={() => syncPref('tgSessionEnd', !localPrefs.tgSessionEnd)}
            />
            <PreferenceToggle
              label={t('settings:integrations.telegramDelegateLabel')}
              hint={t('settings:integrations.telegramDelegateHint')}
              value={localPrefs.tgDelegate}
              onChange={() => syncPref('tgDelegate', !localPrefs.tgDelegate)}
            />
            <PreferenceToggle
              label={t('settings:integrations.telegramLongToolLabel')}
              hint={t('settings:integrations.telegramLongToolHint', {
                ms: localPrefs.tgLongToolMs,
              })}
              value={localPrefs.tgLongToolMs > 0}
              onChange={() => syncPref('tgLongToolMs', localPrefs.tgLongToolMs > 0 ? 0 : 30_000)}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings:integrations.telegramChangesApply')}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('settings:integrations.telegramNotConfigured')}
          </p>
        )}
      </div>
    </div>
  );
}
