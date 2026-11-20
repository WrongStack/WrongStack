import type { Ecosystem } from './registry.js';

/**
 * F18: registries fold canonical-equivalent name spellings. PyPI (PEP 503)
 * treats runs of -_. as a single - and ignores case — `pip install Evil_Pkg`
 * installs the SAME distribution as `evil-pkg`; crates.io folds -/_ and case
 * likewise. npm only case-folds (its name grammar excludes _ and uppercase).
 * Without the ecosystem's normalization a deny entry for `evil-pkg` was
 * evaded by `pip install Evil_Pkg` / `evil.pkg` / `cargo add Evil_Crate` —
 * the same package installed unchecked. Normalize BOTH sides so allow
 * entries and prefix globs keep working across spellings.
 */
function normalizePackageName(name: string, ecosystem: Ecosystem | null): string {
  const lower = name.toLowerCase();
  if (ecosystem === 'PyPI' || ecosystem === 'crates.io') return lower.replace(/[-_.]+/g, '-');
  return lower;
}

export function matchesPattern(
  name: string,
  pattern: string,
  ecosystem: Ecosystem | null,
): boolean {
  const normalized = normalizePackageName(name, ecosystem);
  if (pattern.endsWith('*'))
    return normalized.startsWith(normalizePackageName(pattern.slice(0, -1), ecosystem));
  return normalized === normalizePackageName(pattern, ecosystem);
}
