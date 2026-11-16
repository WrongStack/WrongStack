import { describe, expect, it } from 'vitest';
import { readJson } from '../../src/components/DeadCodeScanPanel/dead-code-panel-model.js';

describe('dead-code-panel-model readJson (F506)', () => {
  it('throws HTTP status error when !res.ok returns JSON null or primitive', async () => {
    const res = new Response('null', { status: 502 });
    await expect(readJson(res)).rejects.toThrow('HTTP 502');
  });
});
