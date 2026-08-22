/**
 * TechStack — Go ecosystem adapter.
 *
 * Parses go.mod manifests and go.sum to produce DependencyObservation[]
 * for Go workspaces.
 *
 * @see docs/specs/techstack-sdd.md §6 Tier A
 */

import { readFileSync } from 'node:fs';
import { buildPurl } from '../registry/purl.js';
import type {
  DependencyObservation,
  DependencyScope,
  EcosystemId,
  Evidence,
  Workspace,
} from '../types.js';
import type { EcosystemAdapter, InventoryOptions } from './interface.js';
import {
  fileExists,
  lockfileEvidence,
  manifestEvidence,
  resolveIn,
  workspaceRoot,
} from './paths.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function cleanGoVersion(v: string): string {
  return v.replace(/^v/i, '');
}

// ── go.mod parser

interface GoRequireStmt {
  readonly modulePath: string;
  readonly version: string;
  /** Indirect dependencies (// indirect comment) */
  readonly indirect?: boolean;
}

/**
 * Parse a go.mod file to extract require statements.
 * Handles:
 *   require module/path v1.2.3
 *   require (
 *       module/path v1.2.3
 *       module/other v0.5.0 // indirect
 *   )
 *   exclude, replace, retract are ignored.
 */
function parseGoMod(content: string): GoRequireStmt[] {
  const deps: GoRequireStmt[] = [];
  const lines = content.split('\n');
  let inRequireBlock = false;

  for (const raw of lines) {
    const line = raw.trim();

    // Skip comments and empty lines
    if (line === '' || line.startsWith('//')) continue;

    // Track require blocks
    if (line.startsWith('require (') && line.endsWith('(')) {
      inRequireBlock = true;
      continue;
    }
    if (line.startsWith('require ') && !line.includes('(')) {
      // Single-line require
      const m = line.match(/^require\s+(\S+)\s+(\S+)/);
      if (m) {
        const indirect = raw.includes('// indirect');
        deps.push({ modulePath: m[1]!, version: cleanGoVersion(m[2]!), indirect });
      }
      continue;
    }

    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        continue;
      }
      // Module path v1.2.3 // indirect
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (m) {
        const indirect = raw.includes('// indirect');
        deps.push({ modulePath: m[1]!, version: cleanGoVersion(m[2]!), indirect });
      }
      continue;
    }

    // Skip exclude/replace/retract blocks
    if (line.startsWith('exclude') || line.startsWith('replace') || line.startsWith('retract')) {
    }
  }

  return deps;
}

function parseGoReplacements(content: string): Map<string, 'path' | 'git'> {
  const replacements = new Map<string, 'path' | 'git'>();
  let inBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === 'replace (') {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const candidate = inBlock ? line : line.startsWith('replace ') ? line.slice(8).trim() : '';
    const match = candidate.match(/^(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)/);
    if (!match) continue;
    const modulePath = match[1];
    const target = match[2];
    if (!modulePath || !target) continue;
    const local =
      target.startsWith('.') || target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target);
    replacements.set(modulePath, local ? 'path' : 'git');
  }
  return replacements;
}

/**
 * Parse go.sum to extract resolved versions.
 * Format: module_path version h1:hash
 * module_path version/go.mod h1:hash
 */
function parseGoSum(content: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // module_path version hash
    const m = line.match(/^(\S+)\s+(\S+)\s+\S+/);
    if (m) {
      const modulePath = m[1]!;
      const version = cleanGoVersion(m[2]!);
      // Only set if not already set (first occurrence wins)
      if (!versions.has(modulePath)) {
        // Pseudo-versions are exact immutable module revisions and are valid
        // locked versions, so retain them like any other go.sum entry.
        versions.set(modulePath, version);
      }
    }
  }
  return versions;
}

/**
 * Extract the module name from go.mod (go module statement).
 */
function parseGoModuleName(content: string): string | undefined {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^module\s+(\S+)/);
    if (m) return m[1]!;
  }
  return undefined;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class GoAdapter implements EcosystemAdapter {
  readonly ecosystem: EcosystemId = 'go';

  async inventory(
    workspace: Workspace,
    options: InventoryOptions,
  ): Promise<readonly DependencyObservation[]> {
    const observations: DependencyObservation[] = [];
    const root = workspaceRoot(workspace, options);
    const seen = new Set<string>();

    // Find go.mod
    const goModPath =
      workspace.manifests.find((m) => m.includes('go.mod')) ||
      (fileExists(resolveIn(root, 'go.mod')) ? 'go.mod' : undefined);
    if (!goModPath) return [];

    const fullManifestPath = resolveIn(root, goModPath);
    let goModContent: string;
    try {
      goModContent = readFileSync(fullManifestPath, 'utf-8');
    } catch {
      return [];
    }

    const manifestEv = manifestEvidence(fullManifestPath);

    // Parse go.mod
    const requires = parseGoMod(goModContent);
    const replacements = parseGoReplacements(goModContent);
    const modName = parseGoModuleName(goModContent);

    // Parse go.sum for locked versions
    const goSumPath = resolveIn(root, 'go.sum');
    let lockVersions = new Map<string, string>();
    let lockEv: Evidence | undefined;
    try {
      const sumContent = readFileSync(goSumPath, 'utf-8');
      lockVersions = parseGoSum(sumContent);
      lockEv = lockfileEvidence(goSumPath);
    } catch {
      // No go.sum
    }

    for (const req of requires) {
      if (seen.has(req.modulePath)) continue;
      seen.add(req.modulePath);

      // Skip the module itself if it appears (rare but possible)
      if (req.modulePath === modName) continue;

      // Determine scope
      // Go has no dev/prod distinction in go.mod — everything is runtime
      // unless marked indirect (which Go treats as transitive)
      const scope: DependencyScope = req.indirect ? 'transitive' : 'runtime';
      const direct = !req.indirect;

      // Resolve locked version
      const locked = lockVersions.get(req.modulePath) || req.version;
      const replacement = replacements.get(req.modulePath);

      // Go module paths work like: github.com/gorilla/mux
      // Build PURL with full module path as name
      const purl = replacement
        ? undefined
        : buildPurl({ type: 'go', name: req.modulePath, version: locked });

      const evidence: Evidence[] = [manifestEv];
      if (lockEv && lockVersions.has(req.modulePath)) evidence.push(lockEv);

      observations.push({
        id: `dep-${workspace.id}-${req.modulePath}`,
        workspaceId: workspace.id,
        ...(purl ? { purl } : {}),
        ecosystem: 'go',
        name: req.modulePath,
        sourceType: replacement ?? 'registry',
        direct,
        scope,
        requested: req.version,
        ...(locked ? { locked } : {}),
        status:
          replacement === 'path'
            ? 'local_path'
            : replacement === 'git'
              ? 'git_dependency'
              : 'current',
        evidence,
      });
    }

    return observations;
  }
}

/**
 * Default singleton instance.
 */
export const goAdapter = new GoAdapter();
