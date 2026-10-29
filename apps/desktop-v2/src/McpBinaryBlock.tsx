import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { mcpBinary, mcpBinaryFileName } from './mcp-binary';

/**
 * Binary MCP content: raster images are previewed from their own bytes, anything can be saved
 * as a file. Nothing is executed or rendered as markup, and text copies still omit it.
 */
export function McpBinaryBlock({ value }: { value: Record<string, unknown> }) {
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
    setNotice(`Save requested for ${name}.`);
  };
  return (
    <div className="mcp-binary">
      {binary.previewable ? (
        <img
          src={`data:${binary.mimeType};base64,${binary.base64}`}
          alt={`MCP content preview, ${binary.mimeType}`}
        />
      ) : (
        <p className="quiet-state">No preview for {binary.mimeType}.</p>
      )}
      <div className="feature-actions">
        <small>
          {binary.mimeType} · {binary.bytes.length.toLocaleString()} bytes · text copy omits this
          block
        </small>
        <button type="button" className="button secondary small" onClick={save}>
          <Download size={12} />
          Save {name}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
