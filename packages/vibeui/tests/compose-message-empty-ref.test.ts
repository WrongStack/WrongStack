import { describe, expect, it } from 'vitest';
import { composeMessage } from '../src/lib/session';

describe('composeMessage empty reference filtering (F1986)', () => {
  it('drops empty and whitespace-only file references before prefixing @', () => {
    expect(composeMessage('hi', ['', '   ', ' src/a.ts ', 'src/a.ts'])).toBe('hi\n@src/a.ts');
  });
});
