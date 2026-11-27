import { Send, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  const [hqUrlDraft, setHqUrlDraft] = useState(localPrefs.hqUrl);
  const [hqTokenDraft, setHqTokenDraft] = useState(localPrefs.hqToken);
  // Telegram poll interval and chat ID commit on blur / Enter rather than on
  // every keystroke, so a half-typed value ("-", "1.") never reaches the
  // server — a rejected `prefs.update` takes the whole payload with it.
  const [pollDraft, setPollDraft] = useState(String(localPrefs.tgPollIntervalSec));
  const [chatDraft, setChatDraft] = useState(localPrefs.tgChatId);
  const [chatInvalid, setChatInvalid] = useState(false);

  useEffect(() => setHqUrlDraft(localPrefs.hqUrl), [localPrefs.hqUrl]);
  useEffect(() => setHqTokenDraft(localPrefs.hqToken), [localPrefs.hqToken]);
  // Re-seed from the server only when the incoming value is a usable one, so
  // a rejected write (group chat without allowGroupChats) does not silently
  // wipe what the user typed.
  useEffect(() => {
    setPollDraft(String(localPrefs.tgPollIntervalSec));
  }, [localPrefs.tgPollIntervalSec]);
  useEffect(() => {
    if (localPrefs.tgChatId !== '') setChatDraft(localPrefs.tgChatId);
  }, [localPrefs.tgChatId]);

  const commitHqUrl = () => {
    if (hqUrlDraft !== localPrefs.hqUrl) syncPref('hqUrl', hqUrlDraft);
  };
  const commitHqToken = () => {
    if (hqTokenDraft !== localPrefs.hqToken) syncPref('hqToken', hqTokenDraft);
  };

  // Mirrors the server's NUMBER_PREF_BOUNDS entry for tgPollIntervalSec: a
  // value outside 1–60 is rejected by validatePreferenceValue, which fails the
  // whole prefs.update payload. Catch it here so the user gets the field-level
  // error instead of a silent no-op that looks like it saved.
  const commitPoll = () => {
    const trimmed = pollDraft.trim();
    if (trimmed === '') return;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60) {
      setPollDraft(String(localPrefs.tgPollIntervalSec));
      return;
    }
    if (parsed !== localPrefs.tgPollIntervalSec) syncPref('tgPollIntervalSec', parsed);
  };

  // Mirrors validateTelegramChatId on the server: empty clears, otherwise a
  // non-zero integer. Group IDs (negative) are accepted here and refused by
  // the server's allowGroupChats guard, which is a config-level decision the
  // panel cannot see.
  const commitChat = () => {
    const trimmed = chatDraft.trim();
    if (trimmed !== '' && !/^-?\d+$/.test(trimmed)) {
      setChatInvalid(true);
      return;
    }
    // As the server: an ID past Number.MAX_SAFE_INTEGER is refused there too.
    if (trimmed !== '' && (Number(trimmed) === 0 || !Number.isSafeInteger(Number(trimmed)))) {
      setChatInvalid(true);
      return;
    }
    setChatInvalid(false);
    if (trimmed !== localPrefs.tgChatId) syncPref('tgChatId', trimmed);
  };

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
              value={hqUrlDraft}
              placeholder={t('activity:integrationsSection.httpHost3499')}
              onChange={(e) => setHqUrlDraft(e.target.value)}
              onBlur={commitHqUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
            <p className="text-xs text-muted-foreground">{t('settings:integrations.hqUrlHint')}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('settings:integrations.hqTokenLabel')}</span>
            <Input
              type="password"
              value={hqTokenDraft}
              placeholder={t('activity:integrationsSection.clientTokenFromWstackHq')}
              onChange={(e) => setHqTokenDraft(e.target.value)}
              onBlur={commitHqToken}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
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
            <div className="space-y-1">
              <label htmlFor="telegram-poll-interval" className="text-sm font-medium">
                {t('settings:integrations.telegramPollIntervalLabel')}
              </label>
              <Input
                id="telegram-poll-interval"
                type="number"
                min={1}
                max={60}
                step={1}
                value={pollDraft}
                onChange={(e) => setPollDraft(e.target.value)}
                onBlur={commitPoll}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings:integrations.telegramPollIntervalHint')}
              </p>
            </div>
            <div className="space-y-1">
              <label htmlFor="telegram-chat-id" className="text-sm font-medium">
                {t('settings:integrations.telegramChatIdLabel')}
              </label>
              <Input
                id="telegram-chat-id"
                inputMode="numeric"
                value={chatDraft}
                aria-invalid={chatInvalid}
                aria-describedby={chatInvalid ? 'telegram-chat-id-error' : undefined}
                onChange={(e) => {
                  setChatDraft(e.target.value);
                  if (chatInvalid) setChatInvalid(false);
                }}
                onBlur={commitChat}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings:integrations.telegramChatIdHint')}
              </p>
              {chatInvalid && (
                <p id="telegram-chat-id-error" role="alert" className="text-xs text-destructive">
                  {t('settings:integrations.telegramChatIdInvalid')}
                </p>
              )}
            </div>
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
