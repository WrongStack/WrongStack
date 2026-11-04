import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DiffPreview } from './DiffPreview';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { saveFileVersion } from './file-save';

/**
 * After an editing Code Assist run: a file as it was before the run next to its current
 * content, and a restore that only writes over exactly the content shown here. A file the run
 * created (`before` null) can be removed again, only while it still holds the content shown.
 */
export function CodeAssistEditReview({
  command,
  path,
  before,
  onRestored,
  note,
}: {
  command: EngineCommand;
  path: string;
  before: string | null;
  onRestored?: () => void;
  note?: string;
}) {
  const { t } = useDesktopText();
  const [after, setAfter] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [removed, setRemoved] = useState(false);
  useEffect(() => {
    let current = true;
    setAfter(null);
    setError('');
    void command('files.read', { filePath: path }, ['files.read'])
      .then((result) => {
        if (!current) return;
        if (result['binary'] || result['tooLarge']) throw Error(t('codeReview.notText'));
        setAfter(String(result['content'] ?? ''));
      })
      .catch((failure) => {
        if (current) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      current = false;
    };
  }, [command, path]);
  const restore = async () => {
    if (after === null) return;
    setBusy(true);
    setError('');
    try {
      if (before === null) {
        const latest = await command('files.read', { filePath: path }, ['files.read']);
        if (latest['content'] !== after) {
          setError(t('codeReview.changedNotRemoved'));
          return;
        }
        await command('files.delete', { filePath: path }, ['files.deleted']);
        setAfter(null);
        setRemoved(true);
        setNotice(t('codeReview.removedFile'));
        onRestored?.();
        return;
      }
      const outcome = await saveFileVersion(command, path, before, after);
      if (outcome.kind === 'conflict') {
        setError(t('codeReview.changedNotRestored'));
        return;
      }
      setAfter(before);
      setNotice(t('codeReview.restored'));
      onRestored?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="code-assist-edit-review" aria-label={t('codeReview.label')}>
      <header>
        <strong>{path}</strong>
        <span>
          {removed
            ? t('codeReview.removed')
            : after === null
              ? t('codeReview.reading')
              : after === before
                ? t('codeReview.same')
                : before === null
                  ? t('codeReview.created')
                  : t('codeReview.changed')}
        </span>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {after !== null && after !== before && (
        <>
          <DiffPreview before={before ?? ''} after={after} path={path} />
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void restore()}
          >
            <RotateCcw size={12} />
            {busy
              ? t('codeReview.restoring')
              : before === null
                ? t('codeReview.removeCreated')
                : t('codeReview.restore')}
          </button>
        </>
      )}
      <small className="field-help">{note ?? t('codeReview.note')}</small>
    </section>
  );
}
