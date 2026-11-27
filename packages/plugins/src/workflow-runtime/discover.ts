/**
 * Default inputs for workflow tools.
 *
 * Several workflows used to require the model to list every changed file,
 * every source file or every workspace manifest by hand — inputs the project
 * already knows. When such a field is omitted, a tool fills it from here:
 * read-only git for changed files, the workspace declaration for manifests,
 * and a bounded walk for source files. Every path stays inside the project
 * root (see `evidence-analyzer/project.ts`).
 */
import { lstat } from 'node:fs/promises';
import { safePath } from '@wrongstack/plugin-sdk/runtime/sandbox';
import {
  changedFiles,
  readJson,
  resolveWorkspaces,
  SOURCE_EXTENSIONS,
  walkFiles,
} from '../evidence-analyzer/project.js';
import { strings, type WorkflowContext } from './index.js';

/** Largest file the workflow readers accept (`readBytes`). */
const MAX_READABLE_BYTES = 2_000_000;

/**
 * Keep the defaulted paths a workflow can actually read: `git diff --name-only`
 * lists deleted files, and a walk can meet a generated file over the 2 MB read
 * cap; either one would fail the whole tool on an input the caller never chose.
 */
async function readable(
  root: string,
  paths: string[],
): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  for (const path of paths) {
    const absolute = safePath(path, { projectRoot: root });
    if (!absolute) continue;
    try {
      const info = await lstat(absolute);
      if (info.isFile() && info.size <= MAX_READABLE_BYTES) files.push(path);
    } catch {
      // Deleted in the working tree, or removed since it was listed.
    }
  }
  return { files, skipped: paths.length - files.length };
}

/** Where a defaulted input came from, reported back so the caller can judge it. */
export type InputSource = 'supplied' | 'git' | 'workspace' | 'project-walk' | 'default';

/** Caller's files when given, otherwise the working-tree change (tracked + untracked). */
export async function filesOrChanged(
  value: unknown,
  context: WorkflowContext,
  tool: string,
  /**
   * `allowEmpty`: a clean tree is a valid answer instead of an error.
   * `includeDeleted`: keep paths that no longer exist (a deletion still
   * changes its package); off for tools that read every file.
   */
  options: { allowEmpty?: boolean; includeDeleted?: boolean } = {},
): Promise<{ files: string[]; source: InputSource; skipped?: number }> {
  if (value !== undefined) return { files: strings(value), source: 'supplied' };
  const listed = await changedFiles(context.root, context.signal);
  const { files: changed, skipped } =
    listed === null
      ? { files: null, skipped: 0 }
      : options.includeDeleted
        ? { files: listed, skipped: 0 }
        : await readable(context.root, listed);
  if (changed === null) {
    throw new Error(
      `${tool}: files was omitted and the changed files could not be read (not a git repository, no commits, or git unavailable); pass files explicitly`,
    );
  }
  if (changed.length === 0 && !options.allowEmpty) {
    throw new Error(
      `${tool}: files was omitted and the working tree has no changes${skipped ? ' that can be read (only deletions or files over 2 MB)' : ''}; pass files explicitly`,
    );
  }
  return { files: changed.slice(0, 2000), source: 'git', ...(skipped ? { skipped } : {}) };
}

/** Caller's files when given, otherwise source files of the project (bounded walk). */
export async function filesOrSources(
  value: unknown,
  context: WorkflowContext,
  maxFiles = 3000,
): Promise<{ files: string[]; source: InputSource; truncated?: boolean; skipped?: number }> {
  if (value !== undefined) return { files: strings(value), source: 'supplied' };
  const walked = await walkFiles(context.root, {
    extensions: SOURCE_EXTENSIONS,
    maxFiles,
    signal: context.signal,
  });
  const { files, skipped } = await readable(context.root, walked.files);
  const truncated = walked.truncated;
  if (files.length === 0)
    throw new Error('No source files found in the project; pass files explicitly');
  return {
    files,
    source: 'project-walk',
    ...(truncated ? { truncated } : {}),
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * Package manifests of the workspace: every declared workspace package, or
 * the root package.json alone when the project is not a workspace.
 */
export async function workspaceManifests(context: WorkflowContext): Promise<string[]> {
  const rootPkg = await readJson(context.root, 'package.json');
  if (rootPkg === undefined)
    throw new Error('No package.json at the project root; pass manifests explicitly');
  const { packages } = await resolveWorkspaces(context.root, rootPkg);
  return packages.length > 0 ? packages.map((dir) => `${dir}/package.json`) : ['package.json'];
}
