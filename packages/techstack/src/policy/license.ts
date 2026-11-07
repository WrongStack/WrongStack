/**
 * TechStack — License Risk & Compliance Classification.
 *
 * Categorizes open source software licenses by risk profile (Permissive,
 * Weak Copyleft, Strong Viral Copyleft, Restrictive/Commercial, Unknown)
 * and generates deterministic compliance findings.
 *
 * @see docs/archive/specs/techstack-sdd.md §4.1, §7
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
  // The SPDX suffixed forms. STRONG_COPYLEFT_LICENSES enumerates the `-only` /
  // `-or-later` variants for GPL and NETWORK_COPYLEFT for AGPL, but the LGPL
  // family was only listed bare — so `LGPL-3.0-or-later` missed this set and
  // reached the GPL fallback below, which matched the 'gpl' inside 'lgpl'.
  'lgpl-2.0-only',
  'lgpl-2.0-or-later',
  'lgpl-2.0+',
  'lgpl-2.1-only',
  'lgpl-2.1-or-later',
  'lgpl-2.1+',
  'lgpl-3.0-only',
  'lgpl-3.0-or-later',
  'lgpl-3.0+',
  'mpl-2.0',
  'cddl-1.0',
  'epl-1.0',
  'epl-2.0',
]);

const STRONG_COPYLEFT_LICENSES = new Set([
  'gpl-2.0',
  'gpl-2.0-only',
  'gpl-2.0-or-later',
  'gpl-2.0+',
  'gpl-3.0',
  'gpl-3.0-only',
  'gpl-3.0-or-later',
  'gpl-3.0+',
  'eupl-1.1',
  'eupl-1.2',
  'osl-3.0',
]);

const NETWORK_COPYLEFT_LICENSES = new Set([
  'agpl-1.0',
  'agpl-1.0-only',
  'agpl-1.0-or-later',
  'agpl-1.0+',
  'agpl-3.0',
  'agpl-3.0-only',
  'agpl-3.0-or-later',
  'agpl-3.0+',
  'sspl-1.0',
]);

const RESTRICTIVE_LICENSES = new Set([
  'bsl-1.1',
  'busl-1.1',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0',
  'commons-clause',
]);

/** Categories an AND operand imposes on the whole expression; 0 = none. */
const STRICT_CATEGORY_RANK: Readonly<Record<LicenseCategory, number>> = {
  permissive: 0,
  weak_copyleft: 1,
  unknown: 0,
  unlicensed: 2,
  restrictive: 3,
  strong_copyleft: 4,
  network_copyleft: 5,
};

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

  // A compound expression matches none of the exact-id sets below: the
  // normalizer encodes `MIT OR Apache-2.0` as `mit/apache-2.0` and
  // `MIT AND Apache-2.0` as `mit+apache-2.0`. Every compound therefore fell
  // through to the final "custom or non-standard license string" branch, and
  // createLicenseFinding() — which returns null only for permissive /
  // weak_copyleft — emitted a licence finding for a fully permissive dependency
  // (this is the de-facto license of the Rust ecosystem). When every branch
  // resolves to the SAME category the expression takes that category; branches
  // that disagree keep the conservative fallbacks below, because the tool cannot
  // know which branch the project relies on.
  const branches = normalized
    .split(/\/|\+(?=[a-z0-9])/)
    .map((branch) => branch.trim())
    .filter((branch) => branch !== '');
  if (branches.length > 1) {
    const branchAssessments = branches.map((branch) => assessLicense(branch));
    const first = branchAssessments[0];
    if (first && branchAssessments.every((assessment) => assessment.category === first.category)) {
      return {
        ...first,
        license: rawLicense,
        rationale: `${rawLicense} combines licenses of the same category (${first.category}). ${first.rationale}`,
      };
    }
    // AND (`+`): every operand's terms apply, so a strict operand decides.
    // Otherwise the `lgpl` substring shortcut below reported
    // `LGPL-2.1 AND AGPL-3.0` as weak copyleft — commercial-safe, no finding.
    // OR keeps the conservative fallbacks: the project may use either branch.
    if (/\+(?=[a-z0-9])/.test(normalized)) {
      const strictest = branchAssessments.reduce((left, right) =>
        STRICT_CATEGORY_RANK[right.category] > STRICT_CATEGORY_RANK[left.category] ? right : left,
      );
      if (STRICT_CATEGORY_RANK[strictest.category] > 0) {
        return {
          ...strictest,
          license: rawLicense,
          rationale: `${rawLicense} requires every listed license; the strictest is ${strictest.category}. ${strictest.rationale}`,
        };
      }
    }
  }

  const lookupId = normalized.replace(/\s+with\s+[a-z0-9.-]+$/i, '').trim();

  if (NETWORK_COPYLEFT_LICENSES.has(lookupId)) {
    return {
      license: rawLicense,
      category: 'network_copyleft',
      severity: 'high',
      isCopyleft: true,
      isCommercialSafe: false,
      rationale: `${rawLicense} carries strict network copyleft terms. Network access may trigger source disclosure requirements.`,
    };
  }

  if (STRONG_COPYLEFT_LICENSES.has(lookupId)) {
    return {
      license: rawLicense,
      category: 'strong_copyleft',
      severity: 'high',
      isCopyleft: true,
      isCommercialSafe: false,
      rationale: `${rawLicense} is viral copyleft. Distributing software including this package may require open sourcing the entire codebase under GPL.`,
    };
  }

  if (RESTRICTIVE_LICENSES.has(lookupId)) {
    return {
      license: rawLicense,
      category: 'restrictive',
      severity: 'high',
      isCopyleft: false,
      isCommercialSafe: false,
      rationale: `${rawLicense} contains non-commercial or source-available restrictions. Check commercial eligibility.`,
    };
  }

  if (WEAK_COPYLEFT_LICENSES.has(lookupId)) {
    return {
      license: rawLicense,
      category: 'weak_copyleft',
      severity: 'info',
      isCopyleft: true,
      isCommercialSafe: true,
      rationale: `${rawLicense} is weak copyleft (file/module level). Safe for proprietary projects when dynamically linked.`,
    };
  }

  if (PERMISSIVE_LICENSES.has(lookupId)) {
    return {
      license: rawLicense,
      category: 'permissive',
      severity: 'info',
      isCopyleft: false,
      isCommercialSafe: true,
      rationale: `${rawLicense} is a standard permissive license. Safe for commercial and closed-source use.`,
    };
  }

  // Weak-copyleft spellings that are not exact SPDX ids (`LGPLv2.1`, `LGPL-3.0+`)
  // and compound expressions built from them. This branch MUST stay ahead of the
  // GPL fallback: that test matches the 'gpl' INSIDE 'lgpl', so every LGPL form
  // missing the exact-id set was reported as viral strong copyleft — a false
  // "open source your entire codebase" compliance finding on a file/module-level
  // license.
  if (normalized.includes('lgpl')) {
    return {
      license: rawLicense,
      category: 'weak_copyleft',
      severity: 'info',
      isCopyleft: true,
      isCommercialSafe: true,
      rationale: `${rawLicense} references LGPL (weak, file/module-level copyleft). Safe for proprietary projects when dynamically linked.`,
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
