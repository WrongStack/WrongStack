/** Shared file snapshot for a collab_debug session: target confinement, limits and reads. */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { expandGlob } from '@wrongstack/core/utils';
import type { CollabSessionOptions, SharedFileSnapshot } from './collab-debug-types.js';

/**
 * Default maximum number of files a collab_debug session may target.
 * Each of the three agents (BugHunter, RefactorPlanner, Critic) receives
 * the full file snapshot as context — a large target causes token overflow
 * and timeout failures. Keep this low (20-30) for reliable sessions.
 * Used when neither `maxTargetFiles` nor `contextWindow` is provided.
 */
export const DEFAULT_MAX_TARGET_FILES = 30;

/**
 * Confine one collab target to the project root (WS-2026-09-17-01).
 *
 * Every sibling file tool routes through `ensureInsideRoot` /
 * `resolveRealInsideRoot`; this path had no equivalent, so a user who enabled
 * `tools.restrictToProjectRoot` got confinement on read/edit/grep/glob and not
 * here — and `collab_debug` embeds what it reads into three subagent prompts,
 * i.e. straight out to the provider.
 *
 * Resolution goes through `realpath`, so an in-root symlink aimed outside is
 * refused too (CWE-59). A path that does not exist resolves lexically: it would
 * fail the read anyway, and deciding it here keeps the answer stable.
 *
 * @returns the resolved path when reading it is allowed, `null` when refused.
 */
export async function resolveCollabTargetInsideRoot(
  filePath: string,
  projectRoot: string | undefined,
  allowOutsideProjectRoot: boolean | undefined,
): Promise<string | null> {
  // Unrestricted access, or no root to measure against: nothing to enforce.
  // Mirrors `resolveRealInsideRoot`, which returns immediately in that case.
  if (allowOutsideProjectRoot === true || !projectRoot) return filePath;
  const realTarget = await fsp.realpath(filePath).catch(() => path.resolve(filePath));
  const realRoot = await fsp.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const rel = path.relative(realRoot, realTarget);
  const inside =
    rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  return inside ? realTarget : null;
}

/**
 * Returns the effective file limit for a session.
 * Priority: explicit `maxTargetFiles` > dynamic from `contextWindow` > `DEFAULT_MAX_TARGET_FILES`.
 */
export function effectiveCollabFileLimit(options: CollabSessionOptions): number {
  if (
    typeof options.maxTargetFiles === 'number' &&
    Number.isFinite(options.maxTargetFiles) &&
    options.maxTargetFiles > 0
  ) {
    return Math.floor(options.maxTargetFiles);
  }
  if (
    typeof options.contextWindow === 'number' &&
    Number.isFinite(options.contextWindow) &&
    options.contextWindow > 0
  ) {
    // Reserve 40% of context window for the file snapshot.
    // Heuristic: ~2000 tokens per average source file.
    return Math.max(5, Math.floor((options.contextWindow * 0.4) / 2000));
  }
  return DEFAULT_MAX_TARGET_FILES;
}

/** Expand, confine, limit-check and read the session's targets into `snapshot.files`. */
export async function readCollabSnapshotFiles(
  snapshot: SharedFileSnapshot,
  options: CollabSessionOptions,
  limit: number,
): Promise<void> {
  const allFiles: string[] = [];
  for (const pattern of options.targetPaths) {
    const expanded = await expandGlob(pattern);
    for (const file of expanded) {
      // The confinement check belongs HERE because this is the read site.
      // `expandGlob` runs again in this method, so a check performed before
      // the call is a TOCTOU window rather than a control (WS-2026-09-17-01).
      const resolved = await resolveCollabTargetInsideRoot(
        file,
        options.projectRoot,
        options.allowOutsideProjectRoot,
      );
      if (resolved === null) {
        throw new Error(
          `[collab_debug] refusing to read "${file}": it resolves outside the project root ` +
            `(${options.projectRoot}). Targets must stay inside the project while ` +
            `tools.restrictToProjectRoot is enabled.`,
        );
      }
      allFiles.push(file);
    }
  }
  if (allFiles.length > limit) {
    const hint = options.contextWindow
      ? `contextWindow=${options.contextWindow} → calculated limit=${limit}`
      : `default limit=${DEFAULT_MAX_TARGET_FILES}`;
    throw new Error(
      `[collab_debug] Target has ${allFiles.length} files, which exceeds the ` +
        `limit (${hint}). Narrow the target or pass maxTargetFiles / contextWindow ` +
        `to override. For large codebases, run package-by-package or ` +
        `module-by-module sessions instead of targeting the entire repo.`,
    );
  }
  for (const filePath of allFiles) {
    try {
      const [content, stat] = await Promise.all([
        fsp.readFile(filePath, 'utf8'),
        fsp.stat(filePath),
      ]);
      const ext = filePath.split('.').pop() ?? '';
      const language =
        ext === 'ts' || ext === 'tsx'
          ? 'typescript'
          : ext === 'js' || ext === 'jsx'
            ? 'javascript'
            : ext === 'md'
              ? 'markdown'
              : ext === 'json'
                ? 'json'
                : undefined;
      snapshot.files.push({
        path: filePath,
        content,
        language,
        snapshotMtimeMs: stat.mtimeMs,
        snapshotSizeBytes: stat.size,
      });
    } catch {
      snapshot.files.push({ path: filePath, content: '', language: undefined });
    }
  }
}
