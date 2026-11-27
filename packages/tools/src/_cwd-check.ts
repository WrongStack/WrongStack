import * as fsp from 'node:fs/promises';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveReal } from './_util.js';

/**
 * Refuse a working directory that is missing or not a directory BEFORE the
 * spawn. Node reports a bad `cwd` as `spawn <binary> ENOENT` — so a typo in
 * `cwd` told the model that `node.exe` (or `pwsh.exe`) was not installed, and
 * the natural next step was to go looking for the binary.
 */
export async function assertWorkingDirectory(
  tool: string,
  field: string,
  shown: string,
  resolved: string,
): Promise<void> {
  const stat = await fsp.stat(resolved).catch(() => null);
  if (stat?.isDirectory()) return;
  throw new ToolValidationError({
    message: `${tool}: ${field} "${shown}" ${stat ? 'is not a directory' : 'does not exist'}`,
    field,
    context: { contract: false },
  });
}

/**
 * Resolve a shell tool's working directory: the requested one or the session
 * working dir / project root, contained to the project (realpath), and
 * confirmed to be an existing directory.
 */
export async function resolveWorkingDirectory(
  tool: string,
  field: string,
  requested: string | undefined,
  ctx: Context,
): Promise<string> {
  const target = requested ?? ctx.workingDir ?? ctx.projectRoot;
  let resolved: string;
  try {
    resolved = await safeResolveReal(target, ctx);
  } catch (err) {
    throw new Error(`${tool}: ${toErrorMessage(err)}`, { cause: err });
  }
  await assertWorkingDirectory(tool, field, target, resolved);
  return resolved;
}
