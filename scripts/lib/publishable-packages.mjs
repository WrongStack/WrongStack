/**
 * Workspace publish inventory and dependency layering.
 *
 * Why this exists
 * ---------------
 * `pnpm publish -r` sorts the workspace topologically but publishes with
 * `workspace-concurrency` > 1, so several packages are in flight at once and
 * the ORDER THE REGISTRY OBSERVES is not the order pnpm printed. On the
 * 0.317.2 release that landed `wrongstack@0.317.2` on npm at 23:30:15Z and
 * `@wrongstack/webui-hq@0.317.2` — a transitive dependency of it — 25 seconds
 * later, so every `npm i -g wrongstack` in that window failed with
 * `ETARGET No matching version found for @wrongstack/webui-hq@0.317.2`.
 * npm's packument cache (both the CDN edge and the client's own, ~5 minutes)
 * then kept the broken resolution alive well past the 25-second gap.
 *
 * The fix is to publish in explicit dependency LAYERS and prove each layer is
 * resolvable on the registry before starting the next, so a package is never
 * on npm before the workspace packages it depends on. This module owns the
 * inventory and the layering; `scripts/publish-workspace.mjs` owns the driving.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Dependency fields that make one workspace package require another at install time. */
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Resolve the workspace member directories from `pnpm-workspace.yaml`, so the
 * list matches what `pnpm publish -r` actually considers — not just `packages/*`.
 * The workspace globs here are simple (`packages/*`, `apps/*`, a literal
 * `website`), so a line parse avoids pulling in a YAML dependency.
 * @param {string} [root] repository root to read the workspace file from
 * @returns {string[]} absolute workspace member directory paths
 */
export function workspaceMemberDirs(root = repoRoot) {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  /** @type {string[]} */
  const dirs = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) {
      const glob = item[1].replace(/^["']|["']$/g, '');
      if (glob.endsWith('/*')) {
        const base = join(root, glob.slice(0, -2));
        if (existsSync(base)) {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(join(base, entry.name));
          }
        }
      } else if (!glob.includes('*') && existsSync(join(root, glob))) {
        dirs.push(join(root, glob));
      }
      continue;
    }
    // First non-list line at column 0 (e.g. `overrides:`) ends the block.
    if (/^\S/.test(line)) break;
  }
  return dirs;
}

/**
 * @typedef {object} PublishablePackage
 * @property {string} name package name as published
 * @property {string} version version in the working tree
 * @property {string} dir absolute directory of the workspace member
 * @property {string | undefined} access declared `publishConfig.access`
 * @property {boolean} provenance whether `publishConfig.provenance` is set
 * @property {string[]} workspaceDeps names of OTHER publishable workspace
 *   packages this one requires at install time
 */

/**
 * Enumerate the workspace packages `pnpm publish -r` would publish.
 * @param {string} [root] repository root
 * @returns {{publishable: PublishablePackage[], skipped: string[]}}
 */
export function collectPublishablePackages(root = repoRoot) {
  /** @type {PublishablePackage[]} */
  const publishable = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {{manifest: Record<string, any>, dir: string}[]} */
  const manifests = [];

  for (const dir of workspaceMemberDirs(root)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private === true) {
      skipped.push(`${manifest.name ?? basename(dir)} (private)`);
      continue;
    }
    manifests.push({ manifest, dir });
  }

  const publishedNames = new Set(manifests.map((m) => m.manifest.name));

  for (const { manifest, dir } of manifests) {
    /** @type {Set<string>} */
    const deps = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        // A package depending on itself (or on a private member, which is
        // never published) contributes no registry ordering constraint.
        if (dep !== manifest.name && publishedNames.has(dep)) deps.add(dep);
      }
    }
    publishable.push({
      name: manifest.name,
      version: manifest.version,
      dir,
      access: manifest.publishConfig?.access,
      provenance: manifest.publishConfig?.provenance === true,
      workspaceDeps: [...deps].sort(),
    });
  }

  publishable.sort((a, b) => a.name.localeCompare(b.name));
  return { publishable, skipped };
}

/**
 * Group packages into publish layers: layer N contains only packages whose
 * workspace dependencies all live in layers < N. Publishing layer by layer,
 * and confirming each layer is live on the registry before starting the next,
 * is what makes a partially-visible release impossible to resolve into a
 * broken tree.
 *
 * A dependency CYCLE cannot be ordered, so the remaining packages are emitted
 * as one final layer and reported in `cycles` for the caller to surface — the
 * publish still happens, it just cannot promise ordering within that group.
 *
 * @param {PublishablePackage[]} packages
 * @returns {{layers: PublishablePackage[][], cycles: string[]}}
 */
export function layerByDependencies(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  /** @type {PublishablePackage[][]} */
  const layers = [];
  /** @type {Set<string>} */
  const placed = new Set();
  let remaining = [...packages];

  while (remaining.length > 0) {
    const ready = remaining.filter((p) =>
      p.workspaceDeps.every((d) => !byName.has(d) || placed.has(d)),
    );
    if (ready.length === 0) {
      // Everything left is in (or behind) a cycle. Ship it as one layer.
      layers.push([...remaining].sort((a, b) => a.name.localeCompare(b.name)));
      return { layers, cycles: remaining.map((p) => p.name).sort() };
    }
    layers.push(ready.sort((a, b) => a.name.localeCompare(b.name)));
    for (const p of ready) placed.add(p.name);
    remaining = remaining.filter((p) => !placed.has(p.name));
  }

  return { layers, cycles: [] };
}
