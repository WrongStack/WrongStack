import { describe, expect, it } from 'vitest';
import { languageIdFor } from '../../src/language-detect.js';

describe('languageIdFor', () => {
  it('detects common TypeScript and JavaScript variants', () => {
    expect(languageIdFor('src/app.ts')).toBe('typescript');
    expect(languageIdFor('src/APP.TS')).toBe('typescript');
    expect(languageIdFor('src/app.test.ts')).toBe('typescript');
    expect(languageIdFor('src/app.tsx')).toBe('typescriptreact');
    expect(languageIdFor('src/app.jsx')).toBe('javascriptreact');
    expect(languageIdFor('src/app.mjs')).toBe('javascript');
    expect(languageIdFor('src/app.test.tsx')).toBe('typescriptreact');
    expect(languageIdFor('src/app.spec.js')).toBe('javascript');
    expect(languageIdFor('src/app.test.jsx')).toBe('javascriptreact');
    expect(languageIdFor('src/SCRIPT.PY')).toBe('python');
  });

  it('detects special filenames', () => {
    expect(languageIdFor('Dockerfile')).toBe('dockerfile');
    expect(languageIdFor('/repo/Makefile')).toBe('makefile');
    expect(languageIdFor('/repo/CMakeLists.txt')).toBe('cmake');
  });

  it('detects YAML and shell files', () => {
    expect(languageIdFor('compose.yaml')).toBe('yaml');
    expect(languageIdFor('deploy.yml')).toBe('yaml');
    expect(languageIdFor('script.sh')).toBe('shellscript');
  });

  it('returns null for unknown files', () => {
    expect(languageIdFor('README.unknown')).toBeNull();
  });
});
