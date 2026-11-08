import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { buildKeyUpdate, maskedApiKey } from './provider-settings-model';

/**
 * Replaces the secret of one saved API key in place (`key.update`): the label, its active choice
 * and the connection stay; only the stored key changes. The result is checked against the saved
 * providers, whose masked key must then show the new one.
 */
export function ProviderKeyReplace({
  providerId,
  label,
  disabled,
  command,
  onStatus,
}: {
  providerId: string;
  label: string;
  disabled: boolean;
  command: EngineCommand;
  onStatus: (status: { ok: boolean; text: string }) => void;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false),
    [apiKey, setApiKey] = useState(''),
    [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    try {
      const message = buildKeyUpdate(
        providerId,
        label,
        apiKey,
        t('providerSettings.replace.missing'),
      );
      const expected = maskedApiKey(message.payload.apiKey);
      setApiKey('');
      await command(message.type, message.payload, ['key.operation_result']);
      const saved = await command('providers.saved', {}, ['providers.saved']);
      const provider = entries(saved['providers']).find((item) => item['id'] === providerId);
      const key = entries(provider?.['apiKeys']).find((item) => item['label'] === label);
      if (!key || key['maskedKey'] !== expected) throw Error(t('providerSettings.unverified'));
      setOpen(false);
      onStatus({
        ok: true,
        text: t('providerSettings.replace.done', { label, provider: providerId }),
      });
    } catch (error) {
      onStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        className="button secondary small"
        disabled={disabled}
        aria-label={t('providerSettings.replace.buttonLabel', { label, provider: providerId })}
        onClick={() => setOpen(true)}
      >
        {t('providerSettings.replace.button')}
      </button>
    );
  return (
    <form
      className="provider-key-replace"
      aria-label={t('providerSettings.replace.buttonLabel', { label, provider: providerId })}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        {t('providerSettings.replace.newKey')}
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={pending}
          placeholder={t('providerSettings.apiKeyPlaceholder')}
        />
      </label>
      <p className="provider-hint">{t('providerSettings.replace.hint', { label })}</p>
      <div className="sdd-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={pending}
          onClick={() => {
            setApiKey('');
            setOpen(false);
          }}
        >
          {t('providerSettings.replace.cancel')}
        </button>
        <button
          type="submit"
          className="button primary small"
          disabled={pending || disabled || !apiKey.trim()}
        >
          {pending && <LoaderCircle size={13} className="spin" />}
          {t('providerSettings.replace.save')}
        </button>
      </div>
    </form>
  );
}
