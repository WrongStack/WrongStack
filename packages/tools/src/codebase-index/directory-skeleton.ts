/**
 * Directory skeletons: every indexable file under a directory outlined by
 * `extractFileSkeleton` and joined into one bounded document.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isIndexablePath } from './languages.js';
import {
  extractFileSkeleton,
  type FileSkeletonResult,
  type SkeletonOptions,
} from './skeleton-extractor.js';

/**
 * Extract skeletons for all indexable files under a directory.
 *
 * `maxChars` bounds the combined skeleton at a file boundary: the file whose
 * part would cross it is left out whole, with every file after it, and named
 * in `omittedFiles` — never cut mid-declaration. The first file always stays.
 */
export async function extractDirectorySkeleton(opts: {
  dirPath: string;
  maxFiles?: number;
  maxChars?: number;
  options?: SkeletonOptions;
}): Promise<{
  files: FileSkeletonResult[];
  combinedSkeleton: string;
  totalOriginalLines: number;
  totalSkeletonLines: number;
  overallSavingsPercent: number;
  /** Directory-relative paths left out by `maxChars`, in scan order. */
  omittedFiles: string[];
  /** The scan stopped at `maxFiles` with more indexable files left. */
  moreFiles: boolean;
}> {
  const maxFiles =
    typeof opts.maxFiles === 'number' && Number.isFinite(opts.maxFiles)
      ? Math.max(0, Math.floor(opts.maxFiles))
      : 30;
  const maxChars =
    typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars)
      ? Math.max(0, opts.maxChars)
      : Number.POSITIVE_INFINITY;
  // One past the limit, to tell "exactly maxFiles" from "more left".
  const scanLimit = maxFiles + 1;
  const filePaths: string[] = [];

  async function scan(dir: string) {
    if (filePaths.length >= scanLimit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filePaths.length >= scanLimit) break;
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && isIndexablePath(fullPath)) {
        filePaths.push(fullPath);
      }
    }
  }

  await scan(opts.dirPath);
  const moreFiles = filePaths.length > maxFiles;
  if (moreFiles) filePaths.length = maxFiles;

  const results: FileSkeletonResult[] = [];
  let totalOrigChars = 0;
  let totalSkelChars = 0;
  let totalOrigLines = 0;
  let totalSkelLines = 0;

  const combinedParts: string[] = [];
  const omittedFiles: string[] = [];
  let combinedChars = 0;

  for (const fp of filePaths) {
    const rel = path.relative(opts.dirPath, fp).replace(/\\/g, '/');
    if (omittedFiles.length > 0) {
      omittedFiles.push(rel);
      continue;
    }
    try {
      const content = await fs.readFile(fp, 'utf8');
      const res = await extractFileSkeleton({
        file: fp,
        content,
        options: opts.options ?? {},
      });
      const part = `// ═══════════════════ ${rel} (${res.lang}) ═══════════════════\n${res.skeleton}`;
      // `\n\n` joins the parts.
      const partChars = part.length + (combinedParts.length > 0 ? 2 : 0);
      if (combinedParts.length > 0 && combinedChars + partChars > maxChars) {
        omittedFiles.push(rel);
        continue;
      }
      combinedChars += partChars;
      results.push(res);
      totalOrigChars += content.length;
      totalSkelChars += res.skeleton.length;
      totalOrigLines += res.stats.originalLines;
      totalSkelLines += res.stats.skeletonLines;
      combinedParts.push(part);
    } catch {
      // Ignore unreadable files
    }
  }

  const overallSavings =
    totalOrigChars > 0 ? ((totalOrigChars - totalSkelChars) / totalOrigChars) * 100 : 0;

  return {
    files: results,
    combinedSkeleton: combinedParts.join('\n\n'),
    totalOriginalLines: totalOrigLines,
    totalSkeletonLines: totalSkelLines,
    overallSavingsPercent: Math.max(0, Math.round(overallSavings * 10) / 10),
    omittedFiles,
    moreFiles,
  };
}
