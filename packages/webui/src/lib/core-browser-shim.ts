/**
 * Browser-safe shim for `@wrongstack/core`.
 *
 * The webui browser bundle imports a small number of pure runtime helpers
 * (currently only `expectDefined`) from `@wrongstack/core`. The real core
 * barrel pulls in Node built-ins (`crypto`, `fs/promises`, `path`, ...) which
 * Rollup cannot externalize as named browser imports, breaking the Vite build.
 *
 * `vite.config.ts` aliases the bare `@wrongstack/core` specifier to this file
 * for the browser build only. The Node-side server package build and the
 * type-checker (tsc) continue to resolve the real package, so type-only
 * imports (`import type { Usage } from '@wrongstack/core'`) are unaffected —
 * they are erased before Vite ever resolves them.
 *
 * Keep these helpers local and dependency-free. Even some narrow core subpaths
 * import server-only prompt/instruction loaders, which pulls Node built-ins into
 * the browser bundle.
 */
export function expectDefined<T>(value: T | null | undefined, label?: string): T {
  if (value === null || value === undefined) {
    const err = new Error(
      label ? `Expected ${label} to be defined` : 'Expected value to be defined',
    );
    err.name = 'ExpectDefinedError';
    throw err;
  }
  return value;
}

export function normalizedEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
