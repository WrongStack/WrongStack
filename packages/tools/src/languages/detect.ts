import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { languageProfileRegistry } from './registry.js';
import type {
  DetectedWorkspace,
  DetectionLimits,
  DetectionResult,
  DetectLanguageOptions,
  LanguageEvidence,
  LanguageProfile,
} from './types.js';

const DEFAULT_LIMITS: DetectionLimits = { maxDepth: 6, maxEntries: 5_000 };
const SOURCE_WEIGHT = 5;
const SOURCE_WEIGHT_CAP = 25;
const TARGET_WEIGHT = 100;

const GLOBAL_IGNORES = new Set([
  '.git',
  '.wrongstack',
  'node_modules',
  'vendor',
  'target',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
]);

interface CandidateState {
  profile: LanguageProfile;
  root: string;
  evidence: LanguageEvidence[];
  manifests: string[];
}

interface ScanState {
  entries: number;
  truncated: boolean;
  sourcePaths: Map<string, string[]>;
  candidates: Map<string, CandidateState>;
}

export async function detectLanguageWorkspaces(
  options: DetectLanguageOptions,
): Promise<DetectionResult> {
  const projectRoot = await canonicalDirectory(options.projectRoot);
  const cwdInput = options.cwd
    ? path.isAbsolute(options.cwd)
      ? options.cwd
      : path.resolve(projectRoot, options.cwd)
    : projectRoot;
  const cwd = await canonicalInside(cwdInput, projectRoot, 'cwd');
  const target = options.target
    ? await canonicalInside(resolveFrom(cwd, options.target), projectRoot, 'target')
    : undefined;
  const profiles = (options.profiles ?? languageProfileRegistry.list())
    .filter((profile) => !options.language || profile.id === options.language)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const limits = normalizeLimits(options.limits);
  const extraIgnores = new Set(options.ignoredDirectories ?? []);
  const state: ScanState = {
    entries: 0,
    truncated: false,
    sourcePaths: new Map(),
    candidates: new Map(),
  };

  await scanDirectory(projectRoot, 0, profiles, limits, state, extraIgnores, options.signal);
  addSourceFallbacks(projectRoot, profiles, state);
  if (target) addTargetEvidence(target, projectRoot, profiles, state);

  const workspaces = await Promise.all(
    [...state.candidates.values()].map((candidate) => finalizeCandidate(candidate, projectRoot)),
  );
  workspaces.sort(compareWorkspaces);
  return {
    projectRoot,
    scannedEntries: state.entries,
    truncated: state.truncated,
    workspaces,
  };
}

async function scanDirectory(
  directory: string,
  depth: number,
  profiles: readonly LanguageProfile[],
  limits: DetectionLimits,
  state: ScanState,
  extraIgnores: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (depth > limits.maxDepth || state.entries >= limits.maxEntries) {
    state.truncated = true;
    return;
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (state.entries >= limits.maxEntries) {
      state.truncated = true;
      return;
    }
    state.entries++;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name, profiles, extraIgnores)) continue;
      if (depth >= limits.maxDepth) {
        state.truncated = true;
        continue;
      }
      await scanDirectory(fullPath, depth + 1, profiles, limits, state, extraIgnores, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    collectFileEvidence(directory, fullPath, entry.name, profiles, state);
  }
}

function collectFileEvidence(
  directory: string,
  fullPath: string,
  basename: string,
  profiles: readonly LanguageProfile[],
  state: ScanState,
): void {
  const lower = basename.toLowerCase();
  const extension = path.extname(lower);
  for (const profile of profiles) {
    const detector = profile.detectors.find((rule) =>
      rule.filename
        ? lower === rule.filename.toLowerCase()
        : lower.endsWith(rule.suffix!.toLowerCase()),
    );
    if (detector) {
      const candidate = getCandidate(state, profile, directory);
      candidate.evidence.push({
        kind: detector.kind,
        path: fullPath,
        value: basename,
        weight: detector.weight,
      });
      if (detector.kind === 'manifest' || detector.kind === 'config') {
        candidate.manifests.push(fullPath);
      }
    }
    if (profile.extensions.includes(extension)) {
      const paths = state.sourcePaths.get(profile.id) ?? [];
      if (paths.length < SOURCE_WEIGHT_CAP / SOURCE_WEIGHT) paths.push(fullPath);
      state.sourcePaths.set(profile.id, paths);
    }
  }
}

function addSourceFallbacks(
  projectRoot: string,
  profiles: readonly LanguageProfile[],
  state: ScanState,
): void {
  for (const profile of profiles) {
    const sources = state.sourcePaths.get(profile.id) ?? [];
    if (sources.length === 0) continue;
    const profileCandidates = [...state.candidates.values()].filter(
      (item) => item.profile.id === profile.id,
    );
    for (const source of sources) {
      const containing = profileCandidates
        .filter((candidate) => isInside(source, candidate.root))
        .sort(
          (a, b) =>
            pathDepth(b.root, projectRoot) - pathDepth(a.root, projectRoot) ||
            a.root.localeCompare(b.root),
        );
      const candidate =
        containing[0] ??
        (profile.sourceFallback === false ? undefined : getCandidate(state, profile, projectRoot));
      if (!candidate) continue;
      candidate.evidence.push({
        kind: 'source',
        path: source,
        value: path.extname(source),
        weight: SOURCE_WEIGHT,
      });
    }
  }
}

function addTargetEvidence(
  target: string,
  projectRoot: string,
  profiles: readonly LanguageProfile[],
  state: ScanState,
): void {
  const extension = path.extname(target).toLowerCase();
  for (const profile of profiles) {
    if (!profile.extensions.includes(extension)) continue;
    const candidates = [...state.candidates.values()].filter(
      (candidate) => candidate.profile.id === profile.id && isInside(target, candidate.root),
    );
    const candidate =
      candidates.length > 0
        ? candidates.sort(
            (a, b) =>
              pathDepth(b.root, projectRoot) - pathDepth(a.root, projectRoot) ||
              a.root.localeCompare(b.root),
          )[0]!
        : profile.sourceFallback === false
          ? undefined
          : getCandidate(state, profile, path.dirname(target));
    if (!candidate) continue;
    candidate.evidence.push({
      kind: 'target',
      path: target,
      value: extension,
      weight: TARGET_WEIGHT,
    });
  }
}

async function finalizeCandidate(
  candidate: CandidateState,
  projectRoot: string,
): Promise<DetectedWorkspace> {
  const evidence = dedupeEvidence(candidate.evidence).sort(compareEvidence);
  const manifests = [...new Set(candidate.manifests)].sort();
  const confidence = Math.min(1, evidence.reduce((sum, item) => sum + item.weight, 0) / 100);
  const packageManager = await detectPackageManager(candidate.profile, candidate.root, evidence);
  const id = createHash('sha256')
    .update(`${candidate.profile.id}\0${path.relative(projectRoot, candidate.root)}`)
    .digest('hex')
    .slice(0, 16);
  return Object.freeze({
    id,
    language: candidate.profile.id,
    root: candidate.root,
    confidence,
    evidence: Object.freeze(evidence.map((item) => Object.freeze(item))),
    ...(packageManager ? { packageManager } : {}),
    manifests: Object.freeze(manifests),
    capabilities: Object.freeze(
      Object.keys(candidate.profile.operations).sort() as DetectedWorkspace['capabilities'],
    ),
  });
}

async function detectPackageManager(
  profile: LanguageProfile,
  root: string,
  evidence: readonly LanguageEvidence[],
): Promise<string | undefined> {
  if (profile.packageManagers.length === 1) return profile.packageManagers[0];
  if (profile.id !== 'typescript' && profile.id !== 'javascript') return undefined;

  let declared: string | undefined;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === 'string') {
      const manager = pkg.packageManager.split('@')[0];
      if (manager && profile.packageManagers.includes(manager)) declared = manager;
    }
  } catch {
    // Missing or malformed package.json is evidence failure, not detector failure.
  }
  const lockManagers = new Set<string>();
  for (const item of evidence) {
    const name = path.basename(item.path).toLowerCase();
    if (name === 'pnpm-lock.yaml') lockManagers.add('pnpm');
    else if (name === 'yarn.lock') lockManagers.add('yarn');
    else if (name === 'bun.lock' || name === 'bun.lockb') lockManagers.add('bun');
    else if (name === 'package-lock.json') lockManagers.add('npm');
  }
  if (
    declared &&
    (lockManagers.size === 0 || (lockManagers.size === 1 && lockManagers.has(declared)))
  ) {
    return declared;
  }
  if (lockManagers.size === 1) return [...lockManagers][0];
  if (lockManagers.size > 1) return undefined;
  return declared ?? 'npm';
}

function getCandidate(state: ScanState, profile: LanguageProfile, root: string): CandidateState {
  const key = `${profile.id}\0${root}`;
  let candidate = state.candidates.get(key);
  if (!candidate) {
    candidate = { profile, root, evidence: [], manifests: [] };
    state.candidates.set(key, candidate);
  }
  return candidate;
}

function shouldIgnoreDirectory(
  name: string,
  profiles: readonly LanguageProfile[],
  extraIgnores: ReadonlySet<string>,
): boolean {
  if (GLOBAL_IGNORES.has(name) || extraIgnores.has(name) || name.startsWith('.')) return true;
  return profiles.some((profile) => profile.ignoredDirectories.includes(name));
}

function normalizeLimits(input: DetectLanguageOptions['limits']): DetectionLimits {
  const maxDepth = Math.max(
    0,
    Math.min(12, Math.trunc(input?.maxDepth ?? DEFAULT_LIMITS.maxDepth)),
  );
  const maxEntries = Math.max(
    1,
    Math.min(50_000, Math.trunc(input?.maxEntries ?? DEFAULT_LIMITS.maxEntries)),
  );
  return { maxDepth, maxEntries };
}

async function canonicalDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(`Project root is not a directory: ${input}`);
  return real;
}

async function canonicalInside(input: string, root: string, label: string): Promise<string> {
  const resolved = path.resolve(input);
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await fs.realpath(path.dirname(resolved));
    real = path.join(parent, path.basename(resolved));
  }
  if (!isInside(real, root)) throw new Error(`${label} is outside project root: ${input}`);
  return real;
}

function resolveFrom(cwd: string, input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathDepth(candidate: string, root: string): number {
  const relative = path.relative(root, candidate);
  return relative === '' ? 0 : relative.split(path.sep).length;
}

function dedupeEvidence(items: readonly LanguageEvidence[]): LanguageEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\0${item.path}\0${item.value}\0${item.weight}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareEvidence(a: LanguageEvidence, b: LanguageEvidence): number {
  return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || b.weight - a.weight;
}

function compareWorkspaces(a: DetectedWorkspace, b: DetectedWorkspace): number {
  return (
    b.confidence - a.confidence ||
    a.language.localeCompare(b.language) ||
    a.root.localeCompare(b.root) ||
    a.id.localeCompare(b.id)
  );
}
