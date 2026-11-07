/**
 * Regression: the `lgpl` substring shortcut classified ANY expression that
 * contained an LGPL id as weak copyleft — including AND expressions whose other
 * operand is GPL, AGPL or non-commercial. Under AND every operand's terms
 * apply, yet the dependency was reported commercial-safe and
 * createLicenseFinding() returned no finding at all.
 */
import { describe, expect, it } from 'vitest';
import {
  assessLicense,
  constructPurl,
  createLicenseFinding,
  parsePurl,
  parsePurlEcosystem,
} from '../../src/index.js';

describe('license AND expressions', () => {
  it.each([
    ['LGPL-2.1 AND GPL-3.0', 'strong_copyleft'],
    ['LGPL-3.0 AND AGPL-3.0', 'network_copyleft'],
    ['LGPL-2.1 AND CC-BY-NC-4.0', 'restrictive'],
    ['(LGPL-2.1 AND BUSL-1.1)', 'restrictive'],
    ['MIT AND UNLICENSED', 'unlicensed'],
  ])('%s is reported at its strictest operand', (expression, category) => {
    const assessment = assessLicense(expression);
    expect(assessment.category).toBe(category);
    expect(assessment.isCommercialSafe).toBe(false);
    expect(createLicenseFinding('dep@1.0.0', 'dep', expression)).not.toBeNull();
  });

  it.each([
    ['GPL-2.0 OR LGPL-2.1', 'weak_copyleft'],
    ['LGPL-2.1 AND MIT', 'weak_copyleft'],
    ['MPL-2.0 AND MIT', 'weak_copyleft'],
    ['MIT AND EPL-2.0', 'weak_copyleft'],
    ['MIT AND Apache-2.0', 'permissive'],
    ['MIT OR Apache-2.0', 'permissive'],
  ])('%s keeps its previous category', (expression, category) => {
    expect(assessLicense(expression).category).toBe(category);
    expect(createLicenseFinding('dep@1.0.0', 'dep', expression)).toBeNull();
  });

  it('parses versionless and unencoded scoped npm PURLs cleanly (F46)', () => {
    expect(parsePurlEcosystem('pkg:npm/@types/node')).toEqual({
      ecosystem: 'npm',
      name: '@types/node',
    });
    expect(parsePurl('pkg:npm/@types/node@22.0.0')).toEqual({
      type: 'npm',
      namespace: '@types',
      name: 'node',
      version: '22.0.0',
    });
  });

  it('classifies SPDX + suffixes and WITH exceptions and normalizes Go/uppercase PURLs (F88)', () => {
    expect(assessLicense('AGPL-3.0+')).toMatchObject({
      category: 'network_copyleft',
      severity: 'high',
    });
    expect(assessLicense('GPL-3.0+')).toMatchObject({
      category: 'strong_copyleft',
      severity: 'high',
    });
    expect(assessLicense('Apache-2.0 WITH LLVM-exception')).toMatchObject({
      category: 'permissive',
      isCommercialSafe: true,
    });
    expect(constructPurl('go', 'github.com/gorilla/mux', '')).toBe(
      'pkg:golang/github.com/gorilla/mux',
    );
    expect(parsePurlEcosystem('pkg:NPM/react@19.1.0')).toEqual({
      ecosystem: 'npm',
      name: 'react',
      version: '19.1.0',
    });
  });
});
