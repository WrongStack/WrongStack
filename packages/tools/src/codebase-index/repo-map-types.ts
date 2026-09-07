/**
 * Shared shapes for the repo map. Split out so the graph-ranked generator and
 * the filesystem fallback can import them without importing each other.
 */

import type { SkeletonOptions } from './skeleton-extractor.js';

export interface RepoMapOptions {
  projectRoot: string;
  maxTokens?: number | undefined;
  focusFiles?: string[] | undefined;
  options?: SkeletonOptions | undefined;
  /** Index directory override, for callers that do not use the default path. */
  indexDir?: string | undefined;
}

export interface RepoMapResult {
  map: string;
  filesCount: number;
  totalFilesScanned: number;
  estimatedTokens: number;
  rankedFiles: string[];
}
