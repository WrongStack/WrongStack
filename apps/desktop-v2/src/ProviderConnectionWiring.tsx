import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import type { ProviderChoice } from './provider-settings-model';

/** Model ids from a comma- or line-separated list, trimmed and without repeats. */
export function parseModelList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * A saved connection's model allowlist and endpoint override (`provider.update`). Clearing the
 * allowlist (`provider.clear_models`) offers every catalog model again and can be undone
 * (`provider.undo_clear`) until this window leaves the connection. The engine validates the
 * endpoint before saving it.
 */
export function ProviderConnectionWiring({
  provider,
  command,
}: {
  provider: ProviderChoice;
  command: EngineCommand;
}) {
  const models = provider.models ?? null;
  const [editing, setEditing] = useState(false),
    [modelText, setModelText] = useState(''),
    [baseUrl, setBaseUrl] = useState(''),
    [cleared, setCleared] = useState<string[] | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const run = async (type: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const reply = await command(type, { ...payload }, ['key.operation_result']);
      const message = (reply as { message?: unknown } | undefined)?.message;
      setNotice(typeof message === 'string' ? message : 'Saved.');
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="provider-wiring"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open) setCleared(null);
      }}
    >
      <summary>
        Models and endpoint ·{' '}
        {models === null
          ? 'all catalog models'
          : `${models.length} allowed ${models.length === 1 ? 'model' : 'models'}`}
        {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
      </summary>
      {editing ? (
        <form
          className="provider-wiring-form"
          onSubmit={(event) => {
            event.preventDefault();
            const list = parseModelList(modelText);
            const url = baseUrl.trim();
            // An empty list means "no allowlist", which is the clear operation, not an empty
            // allowlist; an unchanged endpoint is not rewritten.
            const update = {
              ...(list.length > 0 ? { models: list } : {}),
              ...(url !== (provider.baseUrl ?? '') ? { baseUrl: url } : {}),
            };
            void (async () => {
              let ok = true;
              if (Object.keys(update).length > 0)
                ok = await run('provider.update', { id: provider.id, ...update });
              if (ok && list.length === 0 && models !== null) {
                ok = await run('provider.clear_models', { providerId: provider.id });
                if (ok) setCleared(models);
              }
              if (ok) setEditing(false);
            })();
          }}
        >
          <label>
            Allowed models (one per line or comma-separated)
            <textarea
              rows={4}
              value={modelText}
              disabled={busy}
              onChange={(event) => setModelText(event.target.value)}
            />
          </label>
          <label>
            Endpoint URL (empty uses the provider's own)
            <input
              value={baseUrl}
              disabled={busy}
              placeholder="https://api.example.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <div className="saved-key-actions">
            <button type="submit" className="button primary small" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {models !== null && models.length > 0 && (
            <p className="provider-hint">{models.join(', ')}</p>
          )}
          <div className="saved-key-actions">
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                setModelText((models ?? []).join('\n'));
                setBaseUrl(provider.baseUrl ?? '');
                setEditing(true);
              }}
            >
              Edit
            </button>
            {models !== null && (
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void run('provider.clear_models', { providerId: provider.id }).then((ok) => {
                    if (ok) setCleared(models);
                  })
                }
              >
                Allow every catalog model
              </button>
            )}
            {cleared && models === null && (
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void run('provider.undo_clear', {
                    providerId: provider.id,
                    previousModels: cleared,
                  }).then((ok) => {
                    if (ok) setCleared(null);
                  })
                }
              >
                Undo: restore {cleared.length} {cleared.length === 1 ? 'model' : 'models'}
              </button>
            )}
          </div>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </details>
  );
}
