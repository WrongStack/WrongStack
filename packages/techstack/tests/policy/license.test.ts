import { describe, expect, it } from 'vitest';
import { assessLicense, createLicenseFinding, normalizeLicenseId } from '../../src/index.js';

describe('License Policy & Compliance', () => {
  describe('normalizeLicenseId', () => {
    it('normalizes common license strings', () => {
      expect(normalizeLicenseId('  MIT  ')).toBe('mit');
      expect(normalizeLicenseId('Apache-2.0')).toBe('apache-2.0');
      expect(normalizeLicenseId('(MIT OR Apache-2.0)')).toBe('mit/apache-2.0');
      expect(normalizeLicenseId('(MIT AND BSD-3-Clause)')).toBe('mit+bsd-3-clause');
      expect(normalizeLicenseId('')).toBe('');
      expect(normalizeLicenseId(undefined)).toBe('');
    });
  });

  describe('assessLicense', () => {
    it('identifies permissive licenses as commercial-safe with info severity', () => {
      for (const lic of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense']) {
        const assessment = assessLicense(lic);
        expect(assessment.category).toBe('permissive');
        expect(assessment.isCommercialSafe).toBe(true);
        expect(assessment.isCopyleft).toBe(false);
        expect(assessment.severity).toBe('info');
      }
    });

    it('identifies weak copyleft licenses with info severity and commercial safety', () => {
      for (const lic of ['LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0']) {
        const assessment = assessLicense(lic);
        expect(assessment.category).toBe('weak_copyleft');
        expect(assessment.isCommercialSafe).toBe(true);
        expect(assessment.isCopyleft).toBe(true);
        expect(assessment.severity).toBe('info');
      }
    });

    it('identifies strong copyleft licenses with high severity and copyleft flag', () => {
      for (const lic of ['GPL-2.0', 'GPL-3.0', 'GPL-3.0-only', 'EUPL-1.2']) {
        const assessment = assessLicense(lic);
        expect(assessment.category).toBe('strong_copyleft');
        expect(assessment.isCommercialSafe).toBe(false);
        expect(assessment.isCopyleft).toBe(true);
        expect(assessment.severity).toBe('high');
      }
    });

    it('identifies network copyleft licenses with high severity', () => {
      for (const lic of ['AGPL-3.0', 'AGPL-3.0-or-later', 'SSPL-1.0']) {
        const assessment = assessLicense(lic);
        expect(assessment.category).toBe('network_copyleft');
        expect(assessment.isCommercialSafe).toBe(false);
        expect(assessment.isCopyleft).toBe(true);
        expect(assessment.severity).toBe('high');
      }
    });

    it('identifies restrictive licenses', () => {
      for (const lic of ['BSL-1.1', 'BUSL-1.1', 'CC-BY-NC-4.0']) {
        const assessment = assessLicense(lic);
        expect(assessment.category).toBe('restrictive');
        expect(assessment.isCommercialSafe).toBe(false);
        expect(assessment.severity).toBe('high');
      }
    });

    it('handles unlicensed and empty strings gracefully', () => {
      const empty = assessLicense(undefined);
      expect(empty.category).toBe('unknown');
      expect(empty.isCommercialSafe).toBe(false);

      const unlic = assessLicense('UNLICENSED');
      expect(unlic.category).toBe('unlicensed');
      expect(unlic.severity).toBe('medium');
    });
  });

  describe('createLicenseFinding', () => {
    it('returns null for permissive and weak copyleft licenses', () => {
      expect(createLicenseFinding('dep-1', 'react', 'MIT')).toBeNull();
      expect(createLicenseFinding('dep-2', 'axios', 'Apache-2.0')).toBeNull();
      expect(createLicenseFinding('dep-3', 'some-mpl', 'MPL-2.0')).toBeNull();
    });

    it('creates a finding for viral GPL copyleft licenses', () => {
      const finding = createLicenseFinding('dep-4', 'gpl-tool', 'GPL-3.0');
      expect(finding).not.toBeNull();
      expect(finding?.type).toBe('license');
      expect(finding?.severity).toBe('high');
      expect(finding?.action).toBe('investigate');
      expect(finding?.confidence).toBe(1.0);
      expect(finding?.rationale).toContain('viral copyleft');
    });

    it('creates a finding for network copyleft AGPL licenses', () => {
      const finding = createLicenseFinding('dep-5', 'agpl-backend', 'AGPL-3.0');
      expect(finding).not.toBeNull();
      expect(finding?.type).toBe('license');
      expect(finding?.severity).toBe('high');
      expect(finding?.rationale).toContain('network copyleft');
    });

    it('creates a finding for restrictive licenses', () => {
      const finding = createLicenseFinding('dep-6', 'busl-db', 'BUSL-1.1');
      expect(finding).not.toBeNull();
      expect(finding?.type).toBe('license');
      expect(finding?.severity).toBe('high');
      expect(finding?.rationale).toContain('non-commercial');
    });
  });
});
