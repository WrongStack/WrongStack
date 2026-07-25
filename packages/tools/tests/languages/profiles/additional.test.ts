/**
 * Tests for additional language profiles — profile structure.
 *
 * Coverage targets:
 * - ADDITIONAL_LANGUAGE_PROFILES is a non-empty array
 * - Each profile has required fields (id, displayName, extensions)
 * - Profiles reference expected language ecosystems
 */
import { describe, expect, it } from 'vitest';
import { ADDITIONAL_LANGUAGE_PROFILES } from '../../../src/languages/profiles/additional.js';

describe('ADDITIONAL_LANGUAGE_PROFILES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(ADDITIONAL_LANGUAGE_PROFILES)).toBe(true);
    expect(ADDITIONAL_LANGUAGE_PROFILES.length).toBeGreaterThan(0);
  });

  it('each profile has required fields', () => {
    for (const profile of ADDITIONAL_LANGUAGE_PROFILES) {
      expect(profile).toHaveProperty('id');
      expect(profile).toHaveProperty('displayName');
      expect(profile).toHaveProperty('extensions');
      expect(Array.isArray(profile.extensions)).toBe(true);
      expect(profile.extensions.length).toBeGreaterThan(0);
      expect(profile).toHaveProperty('detectors');
      expect(Array.isArray(profile.detectors)).toBe(true);
      expect(profile).toHaveProperty('lspLanguageIds');
      expect(Array.isArray(profile.lspLanguageIds)).toBe(true);
    }
  });

  it('includes python profile', () => {
    const python = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'python');
    expect(python).toBeDefined();
    expect(python!.displayName).toBe('Python');
    expect(python!.extensions).toContain('.py');
  });

  it('includes java profile', () => {
    const java = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'java');
    expect(java).toBeDefined();
    expect(java!.extensions).toContain('.java');
  });

  it('includes shell profile', () => {
    const shell = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'shell');
    expect(shell).toBeDefined();
    expect(shell!.displayName).toBe('Shell');
  });

  it('includes c profile', () => {
    const c = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'c');
    expect(c).toBeDefined();
  });

  it('includes cpp profile', () => {
    const cpp = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'cpp');
    expect(cpp).toBeDefined();
    expect(cpp!.displayName).toBe('C++');
  });

  it('includes shell profile', () => {
    const shell = ADDITIONAL_LANGUAGE_PROFILES.find((p) => p.id === 'shell');
    expect(shell).toBeDefined();
    expect(shell!.displayName).toBe('Shell');
  });

  it('all profiles have unique ids', () => {
    const ids = ADDITIONAL_LANGUAGE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
