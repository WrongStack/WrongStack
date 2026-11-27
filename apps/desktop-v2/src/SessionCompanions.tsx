import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { FleetPolicySettings } from './FleetPolicySettings';
import { KanbanCompanionSettings } from './KanbanCompanionSettings';

export function SessionCompanions({
  projectId,
  connected,
  command,
}: {
  projectId: string;
  connected: boolean;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    setPrefs({});
    setError('');
    if (connected) {
      void command('prefs.get', {}, ['prefs.updated']).then(
        (value) => {
          if (generation.current === version) setPrefs(value);
        },
        (cause: unknown) => {
          if (generation.current === version)
            setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }
    return () => {
      generation.current++;
    };
  }, [command, connected, retry]);

  const save = async (key: string, value: unknown) => {
    if (!connected || saving.current || typeof value !== 'boolean') return;
    const version = generation.current;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await command('prefs.update', { [key]: value }, ['key.operation_result']);
      const confirmed = await command('prefs.get', {}, ['prefs.updated']);
      if (generation.current !== version) return;
      setPrefs(confirmed);
      if (confirmed[key] !== value) {
        setError(
          t('sessionCompanions.unconfirmed', {
            defaultValue: 'The engine did not confirm the change.',
          }),
        );
      }
    } catch (cause) {
      if (generation.current === version)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="session-companions">
      <FleetPolicySettings
        draft={prefs}
        change={(key, value) => void save(key, value)}
        disabled={!connected || busy}
        companionsOnly
      />
      {error && (
        <div className="session-error settings-feedback-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="button secondary small"
            disabled={!connected || busy}
            onClick={() => setRetry(retry + 1)}
          >
            {t('kanbanCompanion.retry', { defaultValue: 'Try again' })}
          </button>
        </div>
      )}
      <KanbanCompanionSettings key={projectId} projectId={projectId} />
    </div>
  );
}
