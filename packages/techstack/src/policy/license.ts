/**
 * TechStack — License Risk & Compliance Classification.
 *
 * Categorizes open source software licenses by risk profile (Permissive,
 * Weak Copyleft, Strong Viral Copyleft, Restrictive/Commercial, Unknown)
 * and generates deterministic compliance findings.
 *
 * @see docs/specs/techstack-sdd.md §4.1, §7
 */

import type { Finding } from '../types.js';

export type LicenseCategory =
  | 'permissive'
  | 'weak_copyleft'
  | 'strong_copyleft'
  | 'network_copyleft'
  | 'restrictive'
  | 'unlicensed'
  | 'unknown';

export interface LicenseRiskAssessment {
  readonly license: string;
  readonly category: LicenseCategory;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly isCopyleft: boolean;
  readonly isCommercialSafe: boolean;
  readonly rationale: string;
}

const PERMISSIVE_LICENSES = new Set([
  'mit',
  'apache-2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'unlicense',
  'cc0-1.0',
  '0bsd',
  'zlib',
  'wtfpl',
]);

const WEAK_COPYLEFT_LICENSES = new Set([
  'lgpl-2.0',
  'lgpl-2.1',
  'lgpl-3.0',
  'mpl-2.0',
  'cddl-1.0',
  'epl-1.0',
  'epl-2.0',
]);

const STRONG_COPYLEFT_LICENSES = new Set([
  'gpl-2.0',
  'gpl-2.0-only',
  'gpl-2.0-or-later',
  'gpl-3.0',
  'gpl-3.0-only',
  'gpl-3.0-or-later',
  'eupl-1.1',
  'eupl-1.2',
  'osl-3.0',
]);

const NETWORK_COPYLEFT_LICENSES = new Set([
  'agpl-3.0',
  'agpl-3.0-only',
  'agpl-3.0-or-later',
  'sspl-1.0',
]);

const RESTRICTIVE_LICENSES = new Set([
  'bsl-1.1',
  'busl-1.1',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0',
  'commons-clause',
]);

/** Normalize raw license identifier string for SPDX lookup. */
export function normalizeLicenseId(rawLicense: string | undefined): string {
  if (!rawLicense) return '';
  return rawLicense
    .trim()
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+or\s+/g, '/')
    .replace(/\s+and\s+/g, '+');
}

/** Assess the compliance and legal risk of a license. */
export function assessLicense(rawLicense: string | undefined): LicenseRiskAssessment {
  if (!rawLicense || rawLicense.trim() === '') {
    return {
      license: rawLicense ?? 'None',
      category: 'unknown',
      severity: 'low',
      isCopyleft: false,
      isCommercialSafe: false,
      rationale: 'No license declared. Default copyright restrictions apply.',
    };
  }

  const normalized = normalizeLicenseId(rawLicense);

  if (normalized === 'unlicensed' || normalized === 'proprietary') {
    return {
      license: rawLicense,
      category: 'unlicensed',
      severity: 'medium',
      isCopyleft: false,
      isCommercialSafe: false,
      rationale: 'Unlicensed or proprietary dependency. May require explicit vendor permission.',
    };
  }

  if (NETWORK_COPYLEFT_LICENSES.has(normalized)) {
    return {
      license: rawLicense,
      category: 'network_copyleft',
      severity: 'high',
      isCopyleft: true,
      isCommercialSafe: false,
      rationale: `${rawLicense} carries strict network copyleft terms. Network access may trigger source disclosure requirements.`,
    };
  }

  if (STRONG_COPYLEFT_LICENSES.has(normalized)) {
    return {
      license: rawLicense,
      category: 'strong_copyleft',
      severity: 'high',
      isCopyleft: true,
      isCommercialSafe: false,
      rationale: `${rawLicense} is viral copyleft. Distributing software including this package may require open sourcing the entire codebase under GPL.`,
    };
  }

  if (RESTRICTIVE_LICENSES.has(normalized)) {
    return {
      license: rawLicense,
      category: 'restrictive',
      severity: 'high',
      isCopyleft: false,
      isCommercialSafe: false,
      rationale: `${rawLicense} contains non-commercial or source-available restrictions. Check commercial eligibility.`,
    };
  }

  if (WEAK_COPYLEFT_LICENSES.has(normalized)) {
    return {
      license: rawLicense,
      category: 'weak_copyleft',
      severity: 'info',
      isCopyleft: true,
      isCommercialSafe: true,
      rationale: `${rawLicense} is weak copyleft (file/module level). Safe for proprietary projects when dynamically linked.`,
    };
  }

  if (PERMISSIVE_LICENSES.has(normalized)) {
    return {
      license: rawLicense,
      category: 'permissive',
      severity: 'info',
      isCopyleft: false,
      isCommercialSafe: true,
      rationale: `${rawLicense} is a standard permissive license. Safe for commercial and closed-source use.`,
    };
  }

  // Fallback for custom or multi-license strings
  if (normalized.includes('gpl') || normalized.includes('agpl')) {
    return {
      license: rawLicense,
      category: 'strong_copyleft',
      severity: 'medium',
      isCopyleft: true,
      isCommercialSafe: false,
      rationale: `License expression "${rawLicense}" appears to reference GPL/AGPL terms. Review compliance obligations.`,
    };
  }

  return {
    license: rawLicense,
    category: 'unknown',
    severity: 'info',
    isCopyleft: false,
    isCommercialSafe: true,
    rationale: `Custom or non-standard license string "${rawLicense}". Verify terms if distributing binary releases.`,
  };
}

/** Generate a License Compliance Finding if the license represents notable risk. */
export function createLicenseFinding(
  dependencyId: string,
  dependencyName: string,
  rawLicense: string | undefined,
): Finding | null {
  const assessment = assessLicense(rawLicense);
  // Only surface finding when there is actionable risk (copyleft viral or restrictive)
  if (assessment.category === 'permissive' || assessment.category === 'weak_copyleft') {
    return null;
  }

  return {
    id: `finding-${dependencyId}-license`,
    dependencyId,
    type: 'license',
    severity: assessment.severity,
    action: assessment.isCopyleft ? 'investigate' : 'none',
    confidence: 1.0,
    rationale: `[${assessment.license}] ${dependencyName} — ${assessment.rationale}`,
    evidence: [
      {
        kind: 'registry',
        source: 'license-classifier',
        retrievedAt: new Date().toISOString(),
        detail: `Category: ${assessment.category}, Commercial-Safe: ${assessment.isCommercialSafe}`,
      },
    ],
  };
}
