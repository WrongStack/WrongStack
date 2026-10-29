import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DiffPreview } from './DiffPreview';
import type { EngineCommand } from './engine-operations';
import { saveFileVersion } from './file-save';

/**
 * After an editing Code Assist run: the target file as it was before the run next to its
 * current content, and a restore that only writes over exactly the content shown here.
 * Other files the run may have touched are not captured; the working tree shows them.
 */
export function CodeAssistEditReview({
  command,
  path,
  before,
  onRestored,
}: {
  command: EngineCommand;
  path: string;
  before: string;
  onRestored?: () => void;
}) {
  const [after, setAfter] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setAfter(null);
    setError('');
    void command('files.read', { filePath: path }, ['files.read'])
      .then((result) => {
        if (!current) return;
        if (result['binary'] || result['tooLarge'])
          throw Error('The file is no longer readable as text, so no comparison is shown.');
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
      const outcome = await saveFileVersion(command, path, before, after);
      if (outcome.kind === 'conflict') {
        setError(
          'The file changed after this comparison was read. Nothing was restored; refresh the comparison first.',
        );
        return;
      }
      setAfter(before);
      setNotice('Restored the content from before this run.');
      onRestored?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="code-assist-edit-review" aria-label="Changes from this run">
      <header>
        <strong>{path}</strong>
        <span>
          {after === null
            ? 'Reading the current file…'
            : after === before
              ? 'Same as before this run'
              : 'Changed by this run or since it started'}
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
          <DiffPreview before={before} after={after} path={path} />
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void restore()}
          >
            <RotateCcw size={12} />
            {busy ? 'Restoring…' : 'Restore content from before this run'}
          </button>
        </>
      )}
      <small className="field-help">
        Only this file was captured before the run. Review the working tree for other files.
      </small>
    </section>
  );
}
