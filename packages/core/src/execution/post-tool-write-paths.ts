import * as path from 'node:path';
import type { HookInput } from '@wrongstack/contracts/types/hooks';

type WritePaths = Pick<
  NonNullable<HookInput['toolResult']>,
  'modifiedPaths' | 'modifiedPathsOmitted'
>;

/** Preserve bulk-write scope independently of rendered/spooled tool output. */
export function postToolWritePaths(
  toolName: string,
  input: unknown,
  output: unknown,
  context: { projectRoot: string; cwd: string },
  scrub: (text: string) => string,
): WritePaths {
  if (toolName !== 'patch' && toolName !== 'replace') return {};
  if (!output || typeof output !== 'object') return {};
  const result = output as Record<string, unknown>;
  if (result.dry_run === true) return { modifiedPaths: [] };
  if (result.dry_run !== false) return {};
  const entries = toolName === 'patch' ? result.files : result.results;
  if (!Array.isArray(entries)) return {};
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const base =
    toolName === 'patch'
      ? typeof args.directory === 'string' && args.directory.length > 0
        ? path.resolve(context.projectRoot, args.directory)
        : context.cwd
      : context.projectRoot;
  const paths = new Set<string>();
  let omitted = Math.max(0, entries.length - 64);
  for (const entry of entries.slice(0, 64)) {
    const value =
      toolName === 'patch' ? entry : entry && typeof entry === 'object' ? entry.path : undefined;
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      value.includes('\0')
    ) {
      omitted++;
      continue;
    }
    const absolute = path.resolve(base, value);
    // A scrubbed path no longer identifies the file that the tool reported.
    if (scrub(absolute) !== absolute) {
      omitted++;
      continue;
    }
    paths.add(absolute);
  }
  return { modifiedPaths: [...paths], ...(omitted > 0 ? { modifiedPathsOmitted: omitted } : {}) };
}
