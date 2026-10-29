import { describe, expect, it } from 'vitest';
import { mcpBinary, mcpBinaryFileName } from '../src/mcp-binary';

describe('MCP binary content', () => {
  it('decodes resource blobs and prompt data strictly', () => {
    const blob = mcpBinary({ blob: 'AAEC/w==', mimeType: 'IMAGE/PNG' });
    expect(blob).toMatchObject({ mimeType: 'image/png', previewable: true });
    expect([...(blob as { bytes: Uint8Array }).bytes]).toEqual([0, 1, 2, 255]);
    expect(mcpBinary({ data: 'AA\nEC/w==', mimeType: 'application/pdf' })).toMatchObject({
      previewable: false,
    });
    expect(mcpBinary({ data: 'AAEC', mimeType: 'image/svg+xml' })).toMatchObject({
      previewable: false,
    });
    expect(mcpBinary({ blob: 'not base64!' })).toEqual({
      error: 'The binary content is not valid base64.',
    });
    expect(mcpBinary({ blob: 'AAE' })).toHaveProperty('error');
    expect(mcpBinary({ text: 'plain' })).toBeNull();
    expect(mcpBinary({ blob: '' })).toMatchObject({ mimeType: 'application/octet-stream' });
  });
  it('names saved files from the URI without unsafe characters', () => {
    expect(mcpBinaryFileName('repo://native/logo.png', 'image/png')).toBe('logo.png');
    expect(mcpBinaryFileName('repo://native/report?v=1', 'application/pdf')).toBe('report.pdf');
    expect(mcpBinaryFileName('repo://x/a%20b%3Cc%3E', 'image/gif')).toBe('a-b-c-.gif');
    expect(mcpBinaryFileName('repo://x/..', 'image/png')).toBe('mcp-content.png');
    expect(mcpBinaryFileName(undefined, 'audio/x-unknown')).toBe('mcp-content.bin');
  });
});
