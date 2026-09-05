import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export function resolveAndValidateWorkingDir(
  dir: string,
  projectRoot: string,
  allowOutsideProjectRoot: boolean,
): string {
  const resolved = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(projectRoot, dir);

  // Validate containment within projectRoot — unless filesystem access is
  // unrestricted, in which case the working dir may leave the project root.
  if (!allowOutsideProjectRoot) {
    const root = path.resolve(projectRoot);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Working directory "${resolved}" is outside project root "${root}"`);
    }

    let realTarget = resolved;
    let realRoot = root;
    try {
      realTarget = realpathSync.native(resolved);
      realRoot = realpathSync.native(root);
    } catch {
      /* unresolvable — fall back to the lexically-validated pair */
    }
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(
        `Working directory "${resolved}" resolves to "${realTarget}", outside project root "${realRoot}"`,
      );
    }
  }

  return resolved;
}
