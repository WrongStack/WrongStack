import {
  cloudFieldsForProvider,
  type NativeCloudSettings,
  parseNativeCloudSettings,
} from '@wrongstack/contracts/types/native-cloud';
import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import type { ProviderChoice } from './provider-settings-model';

const FIELD_LABELS: Record<keyof NativeCloudSettings, string> = {
  region: 'AWS region',
  project: 'Google Cloud project',
  location: 'Vertex location',
  resourceName: 'Azure resource name',
};

/**
 * A native cloud connection's routing values (Bedrock region, Vertex project and location, Azure
 * resource name), as the WebUI's cloud settings: saved on the profile with `provider.update`,
 * where they override the environment; empty fields fall back to it. Credentials stay separate.
 */
export function ProviderCloudSettings({
  provider,
  command,
}: {
  provider: ProviderChoice;
  command: EngineCommand;
}) {
  const fields = cloudFieldsForProvider(provider.type ?? provider.id);
  const [draft, setDraft] = useState<NativeCloudSettings>(provider.cloud ?? {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  if (!fields.length) return null;
  const saved = fields
    .map((field) => provider.cloud?.[field])
    .filter(Boolean)
    .join(' · ');
  const save = async () => {
    setNotice('');
    setError('');
    let cloud: NativeCloudSettings;
    try {
      cloud = parseNativeCloudSettings(
        Object.fromEntries(fields.map((field) => [field, draft[field]?.trim() ?? ''])),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    setBusy(true);
    try {
      await command('provider.update', { id: provider.id, cloud }, ['key.operation_result']);
      setNotice('Saved. Re-select the provider or restart to use the new settings.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="provider-wiring">
      <summary>Cloud routing · {saved || 'from the environment'}</summary>
      <form
        className="provider-wiring-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="provider-hint">
          Profile values override environment defaults. Empty values use the environment.
          Credentials are managed separately.
        </p>
        {fields.map((field) => (
          <label key={field}>
            {FIELD_LABELS[field]}
            <input
              maxLength={128}
              value={draft[field] ?? ''}
              disabled={busy}
              onChange={(event) => setDraft((value) => ({ ...value, [field]: event.target.value }))}
            />
          </label>
        ))}
        <div className="saved-key-actions">
          <button type="submit" className="button primary small" disabled={busy}>
            {busy ? 'Saving…' : 'Save cloud settings'}
          </button>
        </div>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </details>
  );
}
