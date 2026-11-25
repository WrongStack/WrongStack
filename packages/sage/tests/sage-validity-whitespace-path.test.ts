import { describe, expect, it } from 'vitest';
import { normalizeValidity } from '../src/shared/memory-validity.js';

describe('normalizeValidity trimmed path validation (F2238)', () => {
  it('rejects leading-whitespace absolute and parent-traversal paths', () => {
    expect(() =>
      normalizeValidity({
        statement: 'Only applies on Linux',
        checks: [{ type: 'source_contains', path: '  /etc/passwd', text: 'root:' }],
      }),
    ).toThrow();

    expect(() =>
      normalizeValidity({
        statement: 'Only applies on Linux',
        checks: [{ type: 'source_contains', path: '  ../secret.ts', text: 'key' }],
      }),
    ).toThrow();

    const ok = normalizeValidity({
      statement: 'Valid check',
      checks: [{ type: 'source_contains', path: ' src/index.ts ', text: 'export' }],
    });
    expect(ok?.checks?.[0]?.path).toBe('src/index.ts');
  });
});
