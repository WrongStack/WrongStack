/**
 * TechStack — Discovery wrapper.
 *
 * Thin wrapper around the existing `detectLanguageWorkspaces()` from
 * `@wrongstack/tools` that converts its output into TechStack Workspace[]
 * objects. This is the single entry point for workspace discovery —
 * all downstream code calls this, never the raw detector directly.
 *
 * @see docs/specs/techstack-sdd.md §3.2, §4.1
 */

import { createHash } from 'node:crypto';
import type { Coverage, EcosystemId } from '../types.js';

/**
 * Raw workspace shape returned by detectLanguageWorkspaces().
 * This mirrors the existing interface in packages/tools/src/languages/detect.ts
 * and is intentionally minimal — the real detector returns more fields.
 */
export interface RawWorkspace {
  readonly language: string;
  readonly root: string;
  readonly packageManager?: string | undefined;
  readonly manifests?: readonly string[] | undefined;
  readonly lockfiles?: readonly string[] | undefined;
  readonly confidence?: number | undefined;
  readonly supportedOperations?: readonly string[] | undefined;
}

/** @deprecated Import from `discovery/workspace.js`; retained for compatibility. */
export { discoverWorkspaces } from './workspace.js';

/**
 * Map a raw language string to our EcosystemId.
 * Falls back to the closest match or 'unknown' (not in EcosystemId —
 * the caller filters those out and marks them as unsupported coverage).
 */
export function mapEcosystem(language: string): EcosystemId | undefined {
  const lower = language.toLowerCase();
  const map: Readonly<Record<string, EcosystemId>> = {
    typescript: 'npm',
    javascript: 'npm',
    node: 'npm',
    nodejs: 'npm',
    python: 'python',
    py: 'python',
    rust: 'rust',
    go: 'go',
    golang: 'go',
    csharp: 'dotnet',
    'c#': 'dotnet',
    dotnet: 'dotnet',
    php: 'php',
    dart: 'dart',
    flutter: 'dart',
    java: 'maven',
    kotlin: 'maven',
    ruby: 'ruby',
    swift: 'swift',
    elixir: 'elixir',
    cpp: 'cpp',
    'c++': 'cpp',
    c: 'cpp',
  };
  return map[lower];
}

/**
 * Derive coverage from the raw workspace.
 * If the ecosystem is unsupported or confidence is very low, coverage is partial/unsupported.
 */
export function deriveCoverage(ecosystem: EcosystemId | undefined, confidence: number): Coverage {
  if (!ecosystem) return 'unsupported';
  if (confidence < 0.3) return 'unsupported';
  if (confidence < 0.7) return 'partial';
  return 'full';
}

/**
 * Generate a stable id for a workspace.
 */
export function workspaceId(relativeRoot: string, ecosystem: string): string {
  const hash = createHash('sha256')
    .update(`${ecosystem}:${relativeRoot}`)
    .digest('hex')
    .slice(0, 12);
  return `ws-${hash}`;
}

/**
 * Compute a fingerprint for a set of manifest+lockfile contents.
 * Used for snapshot deduplication — if nothing changed, no need to re-analyze.
 */
export function computeFingerprint(fileContents: readonly string[]): string {
  const hash = createHash('sha256');
  for (const content of fileContents) {
    hash.update(content);
    hash.update('\n'); // separator
  }
  return hash.digest('hex').slice(0, 16);
}
