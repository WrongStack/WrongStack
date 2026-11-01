import { useEffect, useState } from 'react';
import './pdf-frame.css';

/** True when the bytes start with the PDF signature `%PDF-`. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/**
 * Shows PDF bytes in the window's own PDF viewer. The bytes become a blob URL whose type is fixed
 * to `application/pdf`, so they are never parsed as markup; the window CSP allows frames only from
 * such blob URLs. Bytes without the PDF signature are not shown.
 */
export function PdfFrame({ bytes, title }: { bytes: Uint8Array<ArrayBuffer>; title: string }) {
  const [url, setUrl] = useState('');
  const valid = looksLikePdf(bytes);
  useEffect(() => {
    if (!valid) return;
    const next = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, valid]);
  if (!valid) return <p className="quiet-state">These bytes are not a PDF document.</p>;
  return url ? <iframe className="pdf-frame" title={title} src={url} /> : null;
}
