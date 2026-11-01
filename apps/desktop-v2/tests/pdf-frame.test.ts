import { expect, it } from 'vitest';
import { mcpBinary } from '../src/mcp-binary';
import { looksLikePdf } from '../src/PdfFrame';

it('recognizes PDF bytes and previews MCP PDFs', () => {
  expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
  expect(looksLikePdf(new TextEncoder().encode('<html>'))).toBe(false);
  const pdf = mcpBinary({ blob: btoa('%PDF-1.4'), mimeType: 'application/pdf' });
  expect(pdf && 'preview' in pdf ? pdf.preview : null).toBe('pdf');
});
