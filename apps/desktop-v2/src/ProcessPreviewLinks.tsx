import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { openPreview } from './platform';
import { processPreviewUrls } from './process-preview-urls';

/** Local URLs the process printed, each opening a private preview window. */
export function ProcessPreviewLinks({ lines }: { lines: readonly string[] }) {
  const urls = processPreviewUrls(lines);
  const [error, setError] = useState('');
  if (!urls.length) return null;
  return (
    <fieldset className="process-preview-links" aria-label="Local URLs in this output">
      {urls.map((url) => (
        <button
          type="button"
          key={url}
          className="button secondary small"
          onClick={() => {
            setError('');
            openPreview(url).catch((failure) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            );
          }}
        >
          Preview {url}
          <ArrowUpRight size={12} />
        </button>
      ))}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
