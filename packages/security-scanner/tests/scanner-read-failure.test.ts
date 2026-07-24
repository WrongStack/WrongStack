import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/file-gathering.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/file-gathering.js')>();
  return {
    ...actual,
    gatherFiles: async () => ['Z:/definitely-missing/security-source.ts'],
  };
});

import { SecurityScanner } from '../src/scanner.js';

describe('SecurityScanner read failures', () => {
  it('records a gathered file that disappears before it can be read', async () => {
    const scanner = new SecurityScanner();
    const result = await scanner.scan(
      'Z:/definitely-missing',
      {
        patterns: [],
        metadata: { confidence: 1 },
      } as never,
      { stack: 'nodejs' } as never,
    );
    expect(result.scannedFiles).toBe(0);
    expect(result.errors[0]).toContain('security-source.ts');
  });
});
