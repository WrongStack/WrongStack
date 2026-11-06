import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';
import { mcpBinary, mcpBinaryFileName } from './mcp-binary';
import { PdfFrame } from './PdfFrame';

/**
 * Binary MCP content: raster images and audio are previewed from their own bytes, anything can be saved
 * as a file. Nothing is executed or rendered as markup, and text copies still omit it.
 */
export function McpBinaryBlock({ value }: { value: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const binary = useMemo(() => mcpBinary(value), [value]);
  const [notice, setNotice] = useState('');
  if (!binary) return null;
  if ('error' in binary) return <p className="session-error">{binary.error}</p>;
  const name = mcpBinaryFileName(value['uri'], binary.mimeType);
  const save = () => {
    const url = URL.createObjectURL(new Blob([binary.bytes], { type: binary.mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(t('shellText.mcp.saveRequested', { name }));
  };
  return (
    <div className="mcp-binary">
      {binary.preview === 'image' ? (
        <img
          src={`data:${binary.mimeType};base64,${binary.base64}`}
          alt={t('shellText.mcp.imagePreview', { mime: binary.mimeType })}
        />
      ) : binary.preview === 'audio' ? (
        // biome-ignore lint/a11y/useMediaCaption: MCP audio carries no caption track to show.
        <audio
          controls
          preload="metadata"
          src={`data:${binary.mimeType};base64,${binary.base64}`}
          aria-label={t('shellText.mcp.audioPreview', { mime: binary.mimeType })}
        />
      ) : binary.preview === 'pdf' ? (
        <PdfFrame bytes={binary.bytes} title={t('shellText.mcp.pdfPreview', { name })} />
      ) : (
        <p className="quiet-state">{t('shellText.mcp.noPreview', { mime: binary.mimeType })}</p>
      )}
      <div className="feature-actions">
        <small>
          {t('shellText.mcp.details', {
            mime: binary.mimeType,
            bytes: binary.bytes.length.toLocaleString(displayLocale()),
          })}
        </small>
        <button type="button" className="button secondary small" onClick={save}>
          <Download size={12} />
          {t('shellText.mcp.save', { name })}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
