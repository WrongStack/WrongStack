import { describe, expect, it } from 'vitest';
import { processPreviewUrls } from '../src/process-preview-urls';

describe('preview URLs from process output', () => {
  it('finds local URLs newest first, strips colour codes and trailing punctuation', () => {
    const esc = String.fromCharCode(27);
    expect(
      processPreviewUrls([
        'Server ready at http://127.0.0.1:3000/.',
        `  ${esc}[32m➜${esc}[39m  Local:   ${esc}[36mhttp://localhost:${esc}[1m5173${esc}[22m/${esc}[39m`,
        'Network: http://192.168.1.4:5173/ (not local)',
        'listening on http://0.0.0.0:8080',
        'again http://127.0.0.1:3000/',
      ]),
    ).toEqual(['http://127.0.0.1:3000/', 'http://localhost:8080/', 'http://localhost:5173/']);
  });

  it('keeps paths, ignores remote hosts and impossible ports', () => {
    expect(
      processPreviewUrls([
        'docs at http://localhost:4000/docs/index.html, api https://example.com',
        'bad http://localhost:99999/',
        'ipv6 http://[::1]:9000/',
      ]),
    ).toEqual(['http://[::1]:9000/', 'http://localhost:4000/docs/index.html']);
    expect(processPreviewUrls([])).toEqual([]);
  });
});
