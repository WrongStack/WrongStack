import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The role's knowledge checklist: what it verifies from live sources before answering in its
 * domain. One item per line; saving refuses when the stored checklist changed since it was read.
 */
export function RosterKnowledgeChecklist({
  role,
  command,
  disabled,
}: {
  role: string;
  command: EngineCommand;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  const [stored, setStored] = useState<string[] | null>(null),
    [text, setText] = useState(''),
    [threshold, setThreshold] = useState('0.5'),
    [storedThreshold, setStoredThreshold] = useState(0.5),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const result = await command('agent-roster.read-knowledge', { role }, [
        'agent-roster.read-knowledge',
      ]);
      if (typeof result['error'] === 'string') throw Error(result['error']);
      const checklist = Array.isArray(result['checklist']) ? result['checklist'].map(String) : [];
      const verify =
        typeof result['verifyThreshold'] === 'number' ? result['verifyThreshold'] : 0.5;
      setStored(checklist);
      setText(checklist.join('\n'));
      setStoredThreshold(verify);
      setThreshold(String(verify));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [command, role]);
  useEffect(() => {
    setStored(null);
    setNotice('');
    void load();
  }, [load]);
  const value = Number(threshold);
  const validThreshold = threshold.trim() !== '' && value >= 0 && value <= 1;
  const items = lines(text);
  const tooLong = items.some((item) => item.length > 500) || items.length > 50;
  const changed =
    stored !== null &&
    (JSON.stringify(items) !== JSON.stringify(stored) || value !== storedThreshold);
  const save = async () => {
    if (stored === null) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await command(
        'agent-roster.update-knowledge',
        { role, checklist: items, verifyThreshold: value, expectedChecklist: stored },
        ['agent-roster.update-knowledge'],
      );
      if (typeof result['error'] === 'string') throw Error(result['error']);
      setNotice(t('knowledge.saved'));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="roster-knowledge" aria-label={t('knowledge.label', { role })}>
      <h4>{t('knowledge.title')}</h4>
      <p className="field-help">{t('knowledge.help')}</p>
      {stored === null && !error ? (
        <p role="status">{t('knowledge.loading')}</p>
      ) : (
        <>
          <label>
            {t('knowledge.items')}
            <textarea
              aria-label={t('knowledge.itemsLabel')}
              value={text}
              rows={Math.min(10, Math.max(3, items.length + 1))}
              disabled={disabled || busy}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label>
            {t('knowledge.threshold')}
            <input
              aria-label={t('knowledge.thresholdLabel')}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              disabled={disabled || busy}
              onChange={(event) => setThreshold(event.target.value)}
            />
          </label>
          {(tooLong || !validThreshold) && (
            <p className="field-help" role="alert">
              {tooLong ? t('knowledge.tooLong') : t('knowledge.badThreshold')}
            </p>
          )}
          <div className="feature-actions">
            <button
              type="button"
              className="button secondary small"
              disabled={disabled || busy || !changed}
              onClick={() => {
                setText((stored ?? []).join('\n'));
                setThreshold(String(storedThreshold));
              }}
            >
              {t('knowledge.revert')}
            </button>
            <button
              type="button"
              className="button primary small"
              disabled={disabled || busy || !changed || tooLong || !validThreshold}
              onClick={() => void save()}
            >
              {busy ? t('knowledge.saving') : t('knowledge.save')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
