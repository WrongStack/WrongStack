import { describe, expect, it } from 'vitest';
import { detectLang, isIndexablePath } from '../src/codebase-index/languages.js';

// F1345: the special-filename table was a plain object read by the lowercased
// base name, so a file named `constructor` or `__proto__` got the Object
// function / Object.prototype as its "language". The indexer accepted it and
// the SQLite bind of that value rejected the whole index run.
describe('detectLang special filenames (F1345)', () => {
  it('still recognises real special filenames', () => {
    expect(detectLang('src/Makefile')).toBe('other');
    expect(detectLang('Gemfile')).toBe('ruby');
  });

  it.each(['constructor', 'Constructor', '__proto__'])(
    'treats an extension-less file named %j as not indexable',
    (name) => {
      expect(detectLang(`src/${name}`)).toBeNull();
      expect(isIndexablePath(`src/${name}`)).toBe(false);
    },
  );
});
