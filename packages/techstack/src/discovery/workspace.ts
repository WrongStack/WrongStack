/**
 * TechStack — Workspace discovery wrapper.
 *
 * Wraps `detectLanguageWorkspaces()` from `@wrongstack/tools/languages` and
 * maps each `DetectedWorkspace` into a TechStack `Workspace` with:
 * - `EcosystemId` (TechStack's package-manager classification) instead of
 *   the tools-package `LanguageProfileId` (which is language-shaped, not
 *   package-manager-shaped — e.g. both `typescript` and `javascript` map to
 *   `npm`).
 * - `relativeRoot` (project-relative, portable across machines).
 * - `lockfiles` extracted from the detected evidence (manifest/config/lockfile
 *   kinds), independent of which evidence manifests were used.
 * - `coverage` classified against the SDD §6 ecosystem support matrix
 *   (Tier A → `full`, Tier B → `partial`, Tier C/unsupported → `unsupported`).
 *
 * Languages with no `EcosystemId` mapping (`deno`, `shell`) are dropped from
 * the result — they cannot be inventoried by the TechStack pipeline.
 *
 * @see docs/specs/techstack-sdd.md §3.2, §6
 */

import { detectLanguageWorkspaces } from '@wrongstack/tools/languages';
import type {
  DetectLanguageOptions,
  DetectedWorkspace,
  LanguageEvidence,
  LanguageProfileId,
} from '@wrongstack/tools/languages';
import type { Coverage, EcosystemId, Workspace } from '../types.js';

/**
 * Map a language profile id (from `@wrongstack/tools/languages`) to a TechStack
 * ecosystem id. Returns `undefined` for languages that don't correspond to a
 * package-manager ecosystem (e.g. `deno`, `shell`).
 *
 * `java` is disambiguated by gradle-vs-maven evidence: if any lockfile
 * detector matches `gradle.lockfile` we return `gradle`, otherwise `maven`.
 */
const STATIC_LANGUAGE_TO_ECOSYSTEM: Readonly<Record<LanguageProfileId, EcosystemId | undefined>> = {
  typescript: 'npm',
  javascript: 'npm',
  deno: undefined,
  python: 'python',
  go: 'go',
  rust: 'rust',
  csharp: 'dotnet',
  php: 'php',
  ruby: 'ruby',
  swift: 'swift',
  dart: 'dart',
  elixir: 'elixir',
  c: 'cpp',
  cpp: 'cpp',
  java: 'maven', // overridden by `resolveJavaEcosystem` when gradle evidence is present
  shell: undefined,
};

/**
 * Tier classification per SDD §6.
 *
 * Tier A (full deterministic support: inventory + registry + advisory):
 *   npm, python, rust, go, dotnet, php, dart
 * Tier B (partial: best-effort inventory + OSV, may not have rich registry):
 *   maven, gradle, ruby, swift, elixir
 * Tier C (best-effort only — listed here for completeness; same as
 *   `unsupported` in the Coverage union because the SDD defines coverage as
 *   "full / partial / unsupported"):
 *   cpp
 */
const ECOSYSTEM_TIER: Readonly<Record<EcosystemId, Coverage>> = {
  npm: 'full',
  python: 'full',
  rust: 'full',
  go: 'full',
  dotnet: 'full',
  php: 'full',
  dart: 'full',
  maven: 'partial',
  gradle: 'partial',
  ruby: 'partial',
  swift: 'partial',
  elixir: 'partial',
  cpp: 'unsupported',
};

function resolveJavaEcosystem(evidence: readonly LanguageEvidence[]): 'maven' | 'gradle' {
  for (const item of evidence) {
    if (item.kind === 'lockfile' && item.value === 'gradle.lockfile') return 'gradle';
    if (item.kind === 'manifest' && (item.value === 'build.gradle' || item.value === 'build.gradle.kts' || item.value === 'settings.gradle')) {
      return 'gradle';
    }
  }
  return 'maven';
}

function ecosystemForWorkspace(detected: DetectedWorkspace): EcosystemId | undefined {
  if (detected.language === 'java') {
    return resolveJavaEcosystem(detected.evidence);
  }
  return STATIC_LANGUAGE_TO_ECOSYSTEM[detected.language];
}

function extractLockfiles(evidence: readonly LanguageEvidence[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of evidence) {
    if (item.kind !== 'lockfile') continue;
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item.path);
  }
  return out.sort();
}

/**
 * Map a single `DetectedWorkspace` to a TechStack `Workspace`.
 * Returns `undefined` when the language has no TechStack ecosystem mapping.
 */
export function mapDetectedWorkspace(
  detected: DetectedWorkspace,
  projectRoot: string,
): Workspace | undefined {
  const ecosystem = ecosystemForWorkspace(detected);
  if (!ecosystem) return undefined;
  const relativeRoot =
    detected.root === projectRoot
      ? '.'
      : detected.root.startsWith(`${projectRoot}/`) || detected.root.startsWith(`${projectRoot}\\`)
        ? detected.root.slice(projectRoot.length + 1)
        : detected.root;
  const lockfiles = extractLockfiles(detected.evidence);
  return {
    id: detected.id,
    relativeRoot,
    ecosystem,
    ...(detected.packageManager ? { packageManager: detected.packageManager } : {}),
    manifests: [...detected.manifests].sort(),
    lockfiles,
    confidence: Math.max(0, Math.min(1, detected.confidence)),
    coverage: ECOSYSTEM_TIER[ecosystem],
  };
}

/**
 * Directory names whose manifests are test scaffolding, not real project
 * dependencies. A `package.json` under `tests/fixtures/` describes a fake
 * project used to exercise a scanner — inventorying it would surface
 * deliberately-outdated pins (e.g. a fixture pinning `zod@^3`) as findings
 * against the real project. Matched by basename anywhere in the tree;
 * merged with any caller-provided `ignoredDirectories`.
 */
const TEST_FIXTURE_DIRECTORIES: readonly string[] = [
  'fixtures',
  '__fixtures__',
  'test-fixtures',
  'testdata',
  '__mocks__',
];

/**
 * Discover all TechStack workspaces under `projectRoot` by delegating to
 * `detectLanguageWorkspaces` and mapping each detected workspace.
 *
 * Workspaces whose language does not map to a TechStack ecosystem are
 * silently dropped (e.g. `deno`, `shell`) — they cannot be inventoried and
 * would only inflate coverage counts with `unsupported` entries that add no
 * value at the inventory-engine boundary.
 *
 * Test-fixture directories (`fixtures`, `testdata`, …) are skipped so fake
 * fixture manifests never enter the inventory; the project root itself is
 * never skipped, so scanning a fixture directly (as tests do) still works.
 *
 * Results are sorted by `(ecosystem, relativeRoot, id)` for stable display.
 */
export async function discoverWorkspaces(
  projectRoot: string,
  options?: Omit<DetectLanguageOptions, 'projectRoot'>,
): Promise<Workspace[]> {
  const result = await detectLanguageWorkspaces({
    ...(options ?? {}),
    projectRoot,
    ignoredDirectories: [...TEST_FIXTURE_DIRECTORIES, ...(options?.ignoredDirectories ?? [])],
  });
  const mapped: Workspace[] = [];
  for (const detected of result.workspaces) {
    const workspace = mapDetectedWorkspace(detected, result.projectRoot);
    if (workspace) mapped.push(workspace);
  }
  mapped.sort((a, b) => {
    return (
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.relativeRoot.localeCompare(b.relativeRoot) ||
      a.id.localeCompare(b.id)
    );
  });
  return mapped;
}

/**
 * Coverage for a workspace's ecosystem — the per-workspace view of the
 * SDD §6 tier matrix.
 */
export function coverageForEcosystem(ecosystem: EcosystemId): Coverage {
  return ECOSYSTEM_TIER[ecosystem];
}