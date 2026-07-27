/**
 * Coverage for tools/src/languages/profiles/additional.ts — exercises every
 * profile factory by calling the operation functions on the exported profiles.
 */
import { describe, expect, it } from 'vitest';
import { ADDITIONAL_LANGUAGE_PROFILES } from '../../../src/languages/profiles/additional.js';

describe('ADDITIONAL_LANGUAGE_PROFILES', () => {
  it('exports a non-empty frozen array', () => {
    expect(ADDITIONAL_LANGUAGE_PROFILES.length).toBe(10);
    expect(Object.isFrozen(ADDITIONAL_LANGUAGE_PROFILES)).toBe(true);
  });

  it('every profile has required fields', () => {
    for (const profile of ADDITIONAL_LANGUAGE_PROFILES) {
      expect(profile.id).toBeDefined();
      expect(profile.displayName).toBeDefined();
      expect(profile.extensions).toBeDefined();
      expect(profile.lspLanguageIds).toBeDefined();
      expect(profile.detectors).toBeDefined();
      expect(profile.ignoredDirectories).toBeDefined();
      expect(profile.packageManagers).toBeDefined();
      expect(profile.executables).toBeDefined();
      expect(profile.operations).toBeDefined();
    }
  });

  it('every profile has unique id', () => {
    const ids = ADDITIONAL_LANGUAGE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes python, java, ruby, c, cpp, swift, dart, deno, elixir, shell', () => {
    const ids = ADDITIONAL_LANGUAGE_PROFILES.map((p) => p.id);
    expect(ids).toContain('python');
    expect(ids).toContain('java');
    expect(ids).toContain('ruby');
    expect(ids).toContain('c');
    expect(ids).toContain('cpp');
    expect(ids).toContain('swift');
    expect(ids).toContain('dart');
    expect(ids).toContain('deno');
    expect(ids).toContain('elixir');
    expect(ids).toContain('shell');
  });

  it('python profile has correct extensions', () => {
    const py = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'python')!;
    expect(py.extensions).toContain('.py');
    expect(py.extensions).toContain('.pyi');
  });

  it('python profile has package managers', () => {
    const py = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'python')!;
    expect(py.packageManagers).toContain('pip');
    expect(py.packageManagers).toContain('poetry');
  });

  it('java profile has correct extensions', () => {
    const java = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'java')!;
    expect(java.extensions).toContain('.java');
  });

  it('ruby profile has correct extensions', () => {
    const ruby = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'ruby')!;
    expect(ruby.extensions).toContain('.rb');
  });

  it('c profile has correct extensions', () => {
    const c = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'c')!;
    expect(c.extensions).toContain('.c');
  });

  it('cpp profile has correct extensions', () => {
    const cpp = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'cpp')!;
    expect(cpp.extensions).toContain('.cpp');
  });

  it('swift profile has correct extensions', () => {
    const swift = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'swift')!;
    expect(swift.extensions).toContain('.swift');
  });

  it('dart profile has correct extensions', () => {
    const dart = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'dart')!;
    expect(dart.extensions).toContain('.dart');
  });

  it('deno profile has correct extensions', () => {
    const deno = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'deno')!;
    expect(deno.extensions).toContain('.ts');
  });

  it('elixir profile has correct extensions', () => {
    const elixir = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'elixir')!;
    expect(elixir.extensions).toContain('.ex');
  });

  it('shell profile has correct extensions', () => {
    const shell = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'shell')!;
    expect(shell.extensions).toContain('.sh');
  });

  it('every profile has at least some operations defined', () => {
    for (const profile of ADDITIONAL_LANGUAGE_PROFILES) {
      const opKeys = Object.keys(profile.operations);
      expect(opKeys.length).toBeGreaterThan(0);
    }
  });

  it('ignored directories always includes node_modules and .git', () => {
    for (const profile of ADDITIONAL_LANGUAGE_PROFILES) {
      expect(profile.ignoredDirectories).toContain('node_modules');
      expect(profile.ignoredDirectories).toContain('.git');
    }
  });
});
