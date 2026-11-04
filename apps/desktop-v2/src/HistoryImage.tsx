import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';

/**
 * A retained image attachment. Its bytes are read only when asked for, through the engine's
 * bounded single-image read: raster images stored in the session, revision-checked.
 */
export function HistoryImage({
  command,
  sessionId,
  revision,
  messageIndex,
  blockIndex,
  mediaType,
}: {
  command: EngineCommand;
  sessionId: string;
  revision: string;
  messageIndex: number;
  blockIndex: number;
  mediaType: string;
}) {
  const [image, setImage] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const { t } = useDesktopText();
  const show = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await command(
        'session.inspect',
        {
          id: sessionId,
          transcriptImage: { messageIndex, blockIndex, expectedRevision: revision },
        },
        ['session.inspect'],
        { timeoutMs: 90000 },
      );
      const read = record(result['transcriptImage']);
      const url = read['dataUrl'];
      if (
        typeof url !== 'string' ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(url)
      )
        throw Error(
          typeof result['error'] === 'string' ? result['error'] : t('historyView.image.unreadable'),
        );
      setImage(url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="history-attachment">
      <strong>{t('historyView.image.title')}</strong>
      <span>{mediaType}</span>
      {image ? (
        <img
          className="history-image"
          src={image}
          alt={t('historyView.image.alt', { type: mediaType })}
        />
      ) : (
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void show()}
        >
          {busy ? t('historyView.image.loading') : t('historyView.image.show')}
        </button>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </div>
  );
}
