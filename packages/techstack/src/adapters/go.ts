/**
 * TechStack — Go ecosystem adapter.
 *
 * Parses go.mod manifests and go.sum to produce DependencyObservation[]
 * for Go workspaces.
 *
 * @see docs/archive/specs/techstack-sdd.md §6 Tier A
 */

import { readFileSync } from 'node:fs';
import { constructPurl } from '../registry/purl.js';
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
  return v.replace(/^v/i, '').replace(/\/go\.mod$/i, '');
}

// ── go.mod parser

interface GoRequireStmt {
  readonly modulePath: string;
  readonly version: string;
  /** Indirect dependencies (// indirect comment) */
  readonly indirect?: boolean;
}

/** go.mod may quote a module path (`require "example.com/m" v1.0.0`). */
function unquoteGo(token: string): string {
  return token.replace(/^"(.*)"$/, '$1');
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
    // Any go.mod line may end in a `//` comment — a block's `)` and a
    // single-line require included — so structure is read from the code part.
    const line = raw
      .trim()
      .replace(/\/\/.*$/, '')
      .trim();
    const indirect = /\/\/\s*indirect\b/.test(raw);

    // Skip comments and empty lines
    if (line === '') continue;

    // Track require blocks (with or without space before paren)
    if (/^require\s*\(/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (/^require[ \t]+/.test(line) && !line.includes('(')) {
      // Single-line require
      const m = line.match(/^require\s+(\S+)\s+(\S+)/);
      if (m) deps.push({ modulePath: unquoteGo(m[1]!), version: cleanGoVersion(m[2]!), indirect });
      continue;
    }

    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        continue;
      }
      // Module path v1.2.3 // indirect
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (m) deps.push({ modulePath: unquoteGo(m[1]!), version: cleanGoVersion(m[2]!), indirect });
      continue;
    }

    // Skip exclude/replace/retract blocks
    if (line.startsWith('exclude') || line.startsWith('replace') || line.startsWith('retract')) {
    }
  }

  return deps;
}

/**
 * `replace` targets. A local directory is a path dependency; a module at a
 * version (`=> golang.org/x/net v0.30.0`, a fork `=> github.com/me/x v1.2.3`)
 * is still a REGISTRY module — the one actually built — not a git dependency.
 */
type GoReplacement =
  | { kind: 'path' }
  | { kind: 'git' }
  | { kind: 'module'; modulePath: string; version: string };

function replacementKey(modulePath: string, version: string): string {
  return `${modulePath}@${version}`;
}

function parseGoReplacements(content: string): Map<string, GoReplacement> {
  const replacements = new Map<string, GoReplacement>();
  let inBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (/^replace\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const candidate = inBlock ? line : line.startsWith('replace ') ? line.slice(8).trim() : '';
    const match = candidate.match(
      /^("[^"]+"|\S+)(?:\s+(v\S+))?\s+=>\s+("[^"]+"|\S+)(?:\s+(v\S+))?/,
    );
    if (!match?.[1] || !match[3]) continue;
    // Quotes delimit Go path tokens; they are not part of the module identity.
    const modulePath = unquoteGo(match[1]);
    const target = unquoteGo(match[3]);
    const local =
      target.startsWith('.') || target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target);
    // A version on the left replaces ONLY that version (keyed `path@version`);
    // without one, every version of the module is replaced.
    replacements.set(
      match[2] ? replacementKey(modulePath, cleanGoVersion(match[2])) : modulePath,
      local
        ? { kind: 'path' }
        : match[4]
          ? { kind: 'module', modulePath: target, version: cleanGoVersion(match[4]) }
          : { kind: 'git' },
    );
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

      // The version this module resolves to is the one go.mod's `require` states:
      // Go records the selected version there (rewriting minimums to the build
      // list on `go mod tidy`). go.sum is a CHECKSUM LOG, not a resolution list —
      // it keeps one entry per (module, version) ever consulted, written
      // lowest-first, so reading it back returned an OLDER version than the same
      // manifest requires, and the purl built from it sent every OSV query to the
      // wrong component.
      const replacement =
        replacements.get(replacementKey(req.modulePath, req.version)) ??
        replacements.get(req.modulePath);
      // A version replacement is what gets built: its module and version are
      // the identity to check, not the `require` line it overrides.
      const replacedModule = replacement?.kind === 'module' ? replacement : undefined;
      const locked = replacedModule ? replacedModule.version : req.version;
      const replacementKind =
        replacement?.kind === 'path' || replacement?.kind === 'git' ? replacement.kind : undefined;

      // Go module paths work like: github.com/gorilla/mux
      //
      // `constructPurl` is the canonical constructor: it maps the ecosystem to
      // the `golang` purl type and keeps module-path slashes LITERAL (the
      // documented Go exception), so the component is
      // `pkg:golang/github.com/gorilla/mux@1.8.1`. The low-level `buildPurl`
      // treated the path as one name segment and emitted
      // `pkg:go/github.com%2Fgorilla%2Fmux@1.8.1` — a purl whose type and
      // encoding the package's own `parsePurlEcosystem` cannot resolve, so the
      // identity handed to the SBOM and to every per-purl OSV query was
      // unrecognisable.
      const purl = replacementKind
        ? undefined
        : constructPurl('go', replacedModule?.modulePath ?? req.modulePath, locked);

      const evidence: Evidence[] = [manifestEv];
      if (lockEv && lockVersions.has(req.modulePath)) evidence.push(lockEv);

      observations.push({
        id: `dep-${workspace.id}-${req.modulePath}`,
        workspaceId: workspace.id,
        ...(purl ? { purl } : {}),
        ecosystem: 'go',
        name: req.modulePath,
        sourceType: replacementKind ?? 'registry',
        direct,
        scope,
        requested: req.version,
        ...(locked ? { locked } : {}),
        status:
          replacementKind === 'path'
            ? 'local_path'
            : replacementKind === 'git'
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
