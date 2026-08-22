/**
 * TechStack — Python ecosystem adapter.
 *
 * Parses pyproject.toml (PEP 621), requirements.txt, and Pipfile to produce
 * DependencyObservation[] for Python workspaces.
 *
 * Supports: pip, pipenv, poetry, uv — determined by manifest/lockfile presence.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPurl } from '../registry/purl.js';
import type {
  DependencyObservation,
  DependencyScope,
  EcosystemId,
  Evidence,
  Workspace,
} from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import { parseTomlKeyValue } from './parse-utils.js';
import { fileExistsAsync, lockfileEvidence, manifestEvidence, workspaceRoot } from './paths.js';

// ── Helpers ───────────────────────────────────────────────────────────────

// ── Minimal TOML parser (line-based, sufficient for pyproject.toml) ───────

interface TomlSection {
  readonly name: string;
  readonly lines: string[];
}

function parseTomlSections(content: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let currentSection = '__header__';
  let currentLines: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      if (currentLines.length > 0) sections.push({ name: currentSection, lines: currentLines });
      currentSection = sectionMatch[1]!;
      currentLines = [];
    } else {
      currentLines.push(raw);
    }
  }
  if (currentLines.length > 0) sections.push({ name: currentSection, lines: currentLines });
  return sections;
}

function extractTomlArray(sectionLines: string[], key: string): string[] {
  const result: string[] = [];
  let inArray = false;
  for (const line of sectionLines) {
    const trimmed = line.trim();
    if (!inArray) {
      const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*\\[`));
      if (match) {
        inArray = true;
        const rest = trimmed.slice(match[0].length);
        if (rest.includes(']')) {
          const items = rest.replace(/\]\s*,?\s*$/, '').trim();
          for (const item of items.split(',')) {
            const cleaned = item.trim().replace(/^"|"$/g, '').trim();
            if (cleaned) result.push(cleaned);
          }
          inArray = false;
        }
      }
    } else {
      const closeIdx = trimmed.indexOf(']');
      if (closeIdx >= 0) {
        const items = trimmed.slice(0, closeIdx).trim();
        for (const item of items.split(',')) {
          const cleaned = item.trim().replace(/^"|"$/g, '').trim();
          if (cleaned) result.push(cleaned);
        }
        inArray = false;
      } else {
        const cleaned = trimmed.replace(/,$/, '').trim().replace(/^"|"$/g, '').trim();
        if (cleaned) result.push(cleaned);
      }
    }
  }
  return result;
}

function parsePep508(spec: string): { name: string; constraint: string | undefined } {
  let s = spec.trim();
  s = s.replace(/\[.*?\]/g, '');
  const match = s.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*(.*)$/);
  if (!match) return { name: s, constraint: undefined };
  return { name: match[1]!, constraint: match[2]?.trim() || undefined };
}

// ── pyproject.toml parser (PEP 621) ───────────────────────────────────────

function parsePyprojectDeps(
  content: string,
): Array<{ name: string; constraint: string | undefined; scope: DependencyScope }> {
  const deps: Array<{ name: string; constraint: string | undefined; scope: DependencyScope }> = [];
  const sections = parseTomlSections(content);

  const projectSection = sections.find((s) => s.name === 'project');
  if (projectSection) {
    const depSpecs = extractTomlArray(projectSection.lines, 'dependencies');
    for (const spec of depSpecs) {
      const { name, constraint } = parsePep508(spec);
      if (name) deps.push({ name, constraint, scope: 'runtime' });
    }
  }

  for (const section of sections) {
    if (section.name === 'project.optional-dependencies') {
      // Each line is: group_name = ["dep1", "dep2", ...]
      for (const line of section.lines) {
        const trimmed = line.trim();
        const groupMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\[/);
        if (groupMatch) {
          const depSpecs = extractTomlArray(section.lines, groupMatch[1]!);
          for (const spec of depSpecs) {
            const { name, constraint } = parsePep508(spec);
            if (name) deps.push({ name, constraint, scope: 'optional' });
          }
        }
      }
    }

    if (
      section.name === 'tool.poetry.dependencies' ||
      section.name.startsWith('tool.poetry.group.')
    ) {
      const scope: DependencyScope =
        section.name === 'tool.poetry.dependencies' ? 'runtime' : 'development';
      for (const raw of section.lines) {
        const entry = parseTomlKeyValue(raw);
        if (!entry) continue;
        const name = entry.key;
        if (!name || name.toLowerCase() === 'python') continue;
        const rawValue = entry.value;
        const inlineVersion = rawValue.match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1];
        const stringVersion = rawValue.match(/^["']([^"']+)["']/)?.[1];
        deps.push({ name, constraint: inlineVersion ?? stringVersion, scope });
      }
    }
  }

  return deps;
}

// ── requirements.txt parser ────────────────────────────────────────────────

function parseRequirementsTxt(
  content: string,
): Array<{ name: string; constraint: string | undefined }> {
  const deps: Array<{ name: string; constraint: string | undefined }> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const { name, constraint } = parsePep508(line);
    if (name) deps.push({ name, constraint });
  }
  return deps;
}

// ── Pipfile parser ────────────────────────────────────────────────────────

function parsePipfileDeps(
  content: string,
): Array<{ name: string; constraint: string | undefined; scope: DependencyScope }> {
  const deps: Array<{ name: string; constraint: string | undefined; scope: DependencyScope }> = [];
  const sections = parseTomlSections(content);
  for (const section of sections) {
    const scope: DependencyScope = section.name === 'dev-packages' ? 'development' : 'runtime';
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*=\s*"([^"]*)"$/);
      if (match) {
        const constraint = match[2]! === '*' ? undefined : match[2]!;
        deps.push({ name: match[1]!, constraint, scope });
      }
    }
  }
  return deps;
}

function parseRequirementsLockVersions(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*==\s*([^\s;]+)/);
    if (match?.[1] && match[2]) versions.set(normalizePkgName(match[1]), match[2]);
  }
  return versions;
}

function parsePipfileLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const json = JSON.parse(content) as Record<string, Record<string, { version?: string }>>;
    for (const section of ['default', 'develop']) {
      for (const [name, entry] of Object.entries(json[section] ?? {})) {
        if (entry.version?.startsWith('=='))
          versions.set(normalizePkgName(name), entry.version.slice(2));
      }
    }
  } catch {
    // Malformed lockfile.
  }
  return versions;
}

/**
 * Parse poetry.lock to extract resolved versions.
 * Format:
 * [[package]]
 * name = "flask"
 * version = "3.0.3"
 */
export function parsePoetryLock(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  let currentName: string | undefined;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      currentName = nameMatch[1]!;
      continue;
    }
    const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
    if (versionMatch && currentName) {
      versions.set(normalizePkgName(currentName), versionMatch[1]!);
      currentName = undefined;
    }
  }
  return versions;
}

/**
 * Normalize Python package names per PEP 503:
 * underscores and hyphens are equivalent, all lowercase.
 */
function normalizePkgName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-');
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class PythonAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'python';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    const seen = new Set<string>();

    const hasPyproject =
      workspace.manifests.some((m) => m.includes('pyproject.toml')) ||
      (await fileExistsAsync(join(root, 'pyproject.toml')));
    const hasRequirements =
      workspace.manifests.some((m) => m.includes('requirements.txt')) ||
      (await fileExistsAsync(join(root, 'requirements.txt')));
    const hasPipfile =
      workspace.manifests.some((m) => m.includes('Pipfile')) ||
      (await fileExistsAsync(join(root, 'Pipfile')));

    const lockfilePath = await this.detectLockfile(root);

    const allDeps: Array<{
      name: string;
      constraint: string | undefined;
      scope: DependencyScope;
      source: string;
    }> = [];
    let pyprojectEv: Evidence | undefined;

    if (hasPyproject) {
      try {
        const content = await readFile(join(root, 'pyproject.toml'), 'utf-8');
        pyprojectEv = manifestEvidence(join(root, 'pyproject.toml'));
        const parsed = parsePyprojectDeps(content);
        for (const d of parsed) allDeps.push({ ...d, source: 'pyproject.toml' });
      } catch {
        /* ignore */
      }
    }

    let reqLockVersions = new Map<string, string>();
    let requirementsEv: Evidence | undefined;

    if (hasRequirements) {
      try {
        const content = await readFile(join(root, 'requirements.txt'), 'utf-8');
        requirementsEv = manifestEvidence(join(root, 'requirements.txt'));
        const parsed = parseRequirementsTxt(content);
        for (const d of parsed) {
          if (!allDeps.some((existing) => existing.name === d.name)) {
            allDeps.push({ ...d, scope: 'runtime', source: 'requirements.txt' });
          }
        }
        reqLockVersions = parseRequirementsLockVersions(content);
      } catch {
        /* ignore */
      }
    }

    if (hasPipfile) {
      try {
        const content = await readFile(join(root, 'Pipfile'), 'utf-8');
        if (!pyprojectEv) pyprojectEv = manifestEvidence(join(root, 'Pipfile'));
        const parsed = parsePipfileDeps(content);
        for (const d of parsed) {
          if (!allDeps.some((existing) => existing.name === d.name)) {
            allDeps.push({ ...d, source: 'Pipfile' });
          }
        }
      } catch {
        /* ignore */
      }
    }

    let lockEv: Evidence | undefined;
    const lockVersions = new Map(reqLockVersions);
    if (lockfilePath) {
      try {
        const lockContent = await readFile(lockfilePath, 'utf-8');
        const parsed =
          lockfilePath.endsWith('poetry.lock') || lockfilePath.endsWith('uv.lock')
            ? parsePoetryLock(lockContent)
            : parsePipfileLock(lockContent);
        for (const [name, version] of parsed) lockVersions.set(name, version);
        lockEv = lockfileEvidence(lockfilePath);
      } catch {
        /* ignore */
      }
    }

    const manifestEv = pyprojectEv || requirementsEv;

    for (const dep of allDeps) {
      if (seen.has(dep.name)) continue;
      seen.add(dep.name);

      const locked = lockVersions.get(normalizePkgName(dep.name));
      const isRegistry =
        !dep.constraint ||
        (!dep.constraint.startsWith('file:') &&
          !dep.constraint.startsWith('git+') &&
          !dep.constraint.startsWith('-e'));

      const purl =
        isRegistry && locked
          ? buildPurl({ type: 'python', name: dep.name, version: locked })
          : isRegistry
            ? buildPurl({ type: 'python', name: dep.name })
            : undefined;

      const evidence: Evidence[] = [];
      if (manifestEv) evidence.push(manifestEv);
      if (lockEv && locked) evidence.push(lockEv);
      if (evidence.length === 0) {
        evidence.push({
          kind: 'manifest',
          source: dep.source,
          retrievedAt: new Date().toISOString(),
        });
      }

      const status: DependencyObservation['status'] =
        dep.constraint && (dep.constraint.startsWith('file:') || dep.constraint.startsWith('-e'))
          ? 'local_path'
          : dep.constraint?.startsWith('git+')
            ? 'git_dependency'
            : 'current';

      observations.push({
        id: `dep-${workspace.id}-${dep.name}`,
        workspaceId: workspace.id,
        ...(purl ? { purl } : {}),
        ecosystem: 'python',
        name: dep.name,
        sourceType: isRegistry ? 'registry' : status === 'local_path' ? 'path' : 'git',
        direct: true,
        scope: dep.scope,
        ...(dep.constraint ? { requested: dep.constraint } : {}),
        ...(locked ? { locked } : {}),
        status,
        evidence,
      });
    }

    if (options.includeTransitive && lockEv) {
      for (const [name, locked] of lockVersions) {
        if (seen.has(name)) continue;
        seen.add(name);
        observations.push({
          id: `dep-${workspace.id}-${name}`,
          workspaceId: workspace.id,
          purl: buildPurl({ type: 'python', name, version: locked }),
          ecosystem: 'python',
          name,
          sourceType: 'registry',
          direct: false,
          scope: 'transitive',
          locked,
          status: 'current',
          evidence: [lockEv],
        });
      }
    }

    return observations;
  }

  private async detectLockfile(workspaceRoot: string): Promise<string | undefined> {
    for (const file of ['Pipfile.lock', 'poetry.lock', 'uv.lock']) {
      const candidate = join(workspaceRoot, file);
      if (await fileExistsAsync(candidate)) return candidate;
    }
    return undefined;
  }
}

export const pythonAdapter = new PythonAdapter();
