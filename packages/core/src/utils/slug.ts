/**
 * Turn an arbitrary string into a filesystem- and URL-safe lowercase slug.
 *
 * Collapses every run of non-alphanumeric characters into a single hyphen,
 * trims leading/trailing hyphens, and caps the length. Returns `fallback`
 * when the input slugifies to the empty string.
 *
 * Used as the stable dedup + registry key for prompts. (Distinct from the
 * project-folder slug in `wstack-paths.ts`, which has its own `'project'`
 * fallback and shorter cap.)
 */
export function slugify(name: string, fallback = 'prompt', maxLen = 64): string {
  if (typeof name !== 'string' || maxLen <= 0) return fallback;
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, maxLen)
      .replace(/-+$/, '') || fallback
  );
}
