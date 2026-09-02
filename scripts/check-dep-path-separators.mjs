#!/usr/bin/env node
/**
 * Fail if any dependency spec in the workspace contains a Windows path
 * separator (`\`).
 *
 * Registry specs (`^1.2.3`), scoped names, `workspace:*`, `catalog:` and
 * version ranges never legitimately contain a backslash — the only way one
 * appears is a Windows-authored `link:` / `file:` / `portal:` relative path
 * that `pnpm install` happily resolves on NTFS and then breaks on every
 * POSIX machine: `--frozen-lockfile` sees a specifier that does not match
 * the (forward-slashed) lockfile and fails, or the link target simply does
 * not exist as a path.
 *
 * This exact bug shipped in the root package.json (`link:apps\wrongstack`)
 * and only surfaced on Linux CI. The check scans every workspace member
 * manifest plus the `overrides:` block of pnpm-workspace.yaml — the two
 * surfaces where path-bearing specs live — so the whole class is caught at
 * PR time instead of at the first POSIX install.
 *
 *   node scripts/check-dep-path-separators.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Manifest fields that hold dependency specs. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Find backslash-bearing specs in one parsed manifest.
 *
 * @param {string} file repo-relative manifest path, for reporting
 * @param {Record<string, unknown>} manifest parsed package.json
 * @returns {string[]} human-readable findings
 */
export function findBackslashSpecsInManifest(file, manifest) {
  const findings = [];
  const sections = [...DEP_FIELDS.map((field) => [field, manifest[field]])];
  const pnpm = manifest['pnpm'];
  if (pnpm && typeof pnpm === 'object' && !Array.isArray(pnpm)) {
    sections.push(['pnpm.overrides', pnpm['overrides']]);
  }
  for (const [section, value] of sections) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec === 'string' && spec.includes('\\')) {
        findings.push(`${file} ${section}.${name}: "${spec}"`);
      }
    }
  }
  return findings;
}

/**
 * Extract the `packages:` entries from pnpm-workspace.yaml.
 *
 * Deliberately a minimal line scanner, not a YAML dependency: the file's
 * shape here is a flat dash list, and pulling in a parser for five lines
 * adds an install the CI lint job does not otherwise need.
 *
 * @param {string} yamlText raw pnpm-workspace.yaml contents
 * @returns {string[]} workspace entries ("packages/*", "website", …)
 */
export function parseWorkspacePackages(yamlText) {
  const entries = [];
  let inPackages = false;
  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    // Any new top-level key ends the packages block.
    if (inPackages && /^[A-Za-z][\w-]*:/.test(line)) break;
    if (!inPackages) continue;
    const match = /^-\s*["']?([^"'\s#]+)/.exec(line);
    if (match) entries.push(match[1]);
  }
  return entries;
}

/**
 * Extract `name: spec` pairs from the `overrides:` block of
 * pnpm-workspace.yaml. Override values are dependency specs (versions,
 * `link:`/`file:` paths) and can carry the same Windows-separator bug.
 *
 * @param {string} yamlText raw pnpm-workspace.yaml contents
 * @returns {Array<{name: string, spec: string}>} override specs
 */
export function parseOverrideSpecs(yamlText) {
  const overrides = [];
  let inOverrides = false;
  for (const rawLine of yamlText.split('\n')) {
    if (rawLine.trim().startsWith('#')) continue;
    if (/^overrides:/.test(rawLine)) {
      inOverrides = true;
      continue;
    }
    if (inOverrides) {
      // The overrides block is indented under its key; a line back at
      // column 0 starts the next top-level section.
      if (rawLine.length > 0 && !/\s/.test(rawLine[0])) break;
      const match = /^\s+([A-Za-z0-9@._/>-]+):\s*["']?([^"'\s#]+)/.exec(rawLine);
      if (match) overrides.push({ name: match[1], spec: match[2] });
    }
  }
  return overrides;
}

/**
 * Expand the workspace's package entries into member directory paths.
 * Supports single-segment wildcards (`packages/*`) and literal paths
 * (`website`); anything else is skipped with a warning so an exotic glob
 * degrades to less coverage, not a broken check.
 *
 * @param {string} root absolute repo root
 * @param {string[]} entries workspace package entries
 * @returns {string[]} absolute member directories (root included first)
 */
export function expandWorkspaceMembers(root, entries) {
  const members = [root];
  for (const entry of entries) {
    if (!entry.includes('*')) {
      members.push(join(root, entry));
      continue;
    }
    const slash = entry.lastIndexOf('/');
    const parent = slash === -1 ? root : join(root, entry.slice(0, slash));
    const wildcard = entry.slice(slash + 1);
    if (wildcard.includes('*') && wildcard !== '*') {
      console.warn(`check-dep-path-separators: unsupported glob "${entry}" — skipped`);
      continue;
    }
    let dirents;
    try {
      dirents = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory() && !dirent.name.startsWith('.')) {
        members.push(join(parent, dirent.name));
      }
    }
  }
  return members;
}

/**
 * Run the full check. Scans every workspace member manifest and the
 * pnpm-workspace.yaml overrides block.
 *
 * @param {string} root absolute repo root
 * @returns {string[]} all findings, repo-relative
 */
export function collectFindings(root) {
  const findings = [];
  const workspaceYamlPath = join(root, 'pnpm-workspace.yaml');
  const workspaceYaml = existsSync(workspaceYamlPath)
    ? readFileSync(workspaceYamlPath, 'utf8')
    : '';
  const members = expandWorkspaceMembers(
    root,
    workspaceYaml ? parseWorkspacePackages(workspaceYaml) : ['packages/*', 'apps/*'],
  );
  for (const member of members) {
    const manifestPath = join(member, 'package.json');
    if (!existsSync(manifestPath)) continue;
    // Strip the path-separator remnant so member paths read "packages/x"
    // on both Windows (join uses backslashes) and POSIX.
    const relative =
      member === root
        ? ''
        : member
            .slice(root.length)
            .replace(/^[\\/]+/, '')
            .replaceAll('\\', '/');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      findings.push(`${relative || '.'}/package.json: unparseable JSON (${String(error)})`);
      continue;
    }
    findings.push(
      ...findBackslashSpecsInManifest(`${relative ? `${relative}/` : ''}package.json`, manifest),
    );
  }
  for (const override of parseOverrideSpecs(workspaceYaml)) {
    if (override.spec.includes('\\')) {
      findings.push(`pnpm-workspace.yaml overrides.${override.name}: "${override.spec}"`);
    }
  }
  return findings.sort();
}

// Only act when run directly, so the helpers stay importable from tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  const findings = collectFindings(repoRoot);
  if (findings.length > 0) {
    console.error(
      `Dependency specs contain Windows path separators (\\):\n` +
        `${findings.map((f) => `  ${f}`).join('\n')}\n\n` +
        `pnpm resolves these on Windows and then every POSIX install fails\n` +
        `(frozen-lockfile mismatch or a link target that does not exist).\n` +
        `Use forward slashes in link:/file:/portal: specs.`,
    );
    process.exit(1);
  }
  console.log('No backslash path separators in dependency specs.');
}
