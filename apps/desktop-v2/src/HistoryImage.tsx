import { useState } from 'react';
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
          typeof result['error'] === 'string'
            ? result['error']
            : 'This engine did not return the image. It may predate image reads in history.',
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
      <strong>Image attachment</strong>
      <span>{mediaType}</span>
      {image ? (
        <img
          className="history-image"
          src={image}
          alt={`Retained image attachment, ${mediaType}`}
        />
      ) : (
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void show()}
        >
          {busy ? 'Loading image…' : 'Show image'}
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
