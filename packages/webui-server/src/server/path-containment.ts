import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/core/types';

export function isPathInside(root: string, target: string): boolean {
  const normRoot =
    process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const normTarget =
    process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
  const relative = path.relative(normRoot, normTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolveWorkingDirInsideProject(
  projectRoot: string,
  inputPath: string,
): Promise<string> {
  const resolved = path.resolve(projectRoot, inputPath);

  // Reject lexical escapes before touching the target so callers receive a
  // containment error even when the escaped path does not exist.
  if (!isPathInside(path.resolve(projectRoot), resolved)) {
    throw new ToolValidationError({
      message: `Path must stay inside the project root: ${projectRoot}`,
      field: 'path',
    });
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new ToolValidationError({
      message: `Directory not found or not accessible: ${resolved}`,
      field: 'path',
    });
  }
  if (!stat.isDirectory()) {
    throw new ToolValidationError({
      message: `Directory not found or not accessible: ${resolved}`,
      field: 'path',
    });
  }

  const [realProjectRoot, realResolved] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(resolved),
  ]);

  if (!isPathInside(realProjectRoot, realResolved)) {
    throw new ToolValidationError({
      message: `Path must stay inside the project root: ${projectRoot}`,
      field: 'path',
    });
  }

  return resolved;
}
