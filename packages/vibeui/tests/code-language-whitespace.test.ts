import { describe, expect, it } from 'vitest';
import { codeLanguage } from '../src/lib/code-content';

describe('codeLanguage (F2186)', () => {
  it('trims leading and trailing whitespace from path hints', () => {
    expect(codeLanguage('  src/app.ts  ')).toBe('typescript');
    expect(codeLanguage('  Dockerfile  ')).toBe('dockerfile');
  });
});
