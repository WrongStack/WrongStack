/**
 * Build guard for @wrongstack/sage.
 *
 * CLI tests import @wrongstack/sage directly. In this shared worktree a
 * sibling package build that wipes/recreates sage's dist/ mid-flight makes
 * suite loads fail with:
 *   "Failed to resolve entry for package '@wrongstack/sage'."
 * Resolve the package entry up front; when it is unresolvable, build the
 * package once before any test boots. When it resolves this is a no-op.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

export default function ensureSageBuilt(): void {
  const require = createRequire(import.meta.url);
  try {
    require.resolve('@wrongstack/sage');
    return; // Entry resolvable — nothing to do.
  } catch {
    execSync('pnpm --filter @wrongstack/sage build', { stdio: 'inherit' });
  }
}
