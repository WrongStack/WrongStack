/**
 * Lightweight project context for SDD interviews. Shared by CLI `/sdd` and the
 * WebUI wizard so both surfaces inject the same footprint into AI prompts
 * (package.json, TypeScript, top-level src layout) without depending on each other.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Build a short, model-friendly summary of the project root. Best-effort —
 * missing files simply omit their section; never throws.
 */
export async function gatherProjectContext(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  const root = projectRoot.trim() || process.cwd();

  try {
    const pkgPath = path.join(root, 'package.json');
    const pkgRaw = await fsp.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    parts.push(`Project: ${String(pkg.name ?? 'unknown')}`);
    parts.push(`Description: ${String(pkg.description ?? 'none')}`);
    if (pkg.dependencies && typeof pkg.dependencies === 'object') {
      const deps = Object.keys(pkg.dependencies as Record<string, unknown>);
      parts.push(`Dependencies: ${deps.slice(0, 20).join(', ')}${deps.length > 20 ? '...' : ''}`);
    }
    if (pkg.devDependencies && typeof pkg.devDependencies === 'object') {
      const devDeps = Object.keys(pkg.devDependencies as Record<string, unknown>);
      parts.push(
        `Dev Dependencies: ${devDeps.slice(0, 15).join(', ')}${devDeps.length > 15 ? '...' : ''}`,
      );
    }
  } catch {
    /* no package.json */
  }

  try {
    await fsp.access(path.join(root, 'tsconfig.json'));
    parts.push('Language: TypeScript');
  } catch {
    /* no tsconfig */
  }

  try {
    const srcDir = path.join(root, 'src');
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length > 0) parts.push(`Source structure: src/${dirs.join(', src/')}`);
  } catch {
    /* no src dir */
  }

  // Monorepo packages/ layout (WrongStack-style) — useful when no root package.json deps.
  try {
    const packagesDir = path.join(root, 'packages');
    const entries = await fsp.readdir(packagesDir, { withFileTypes: true });
    const pkgs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (pkgs.length > 0) {
      parts.push(`Packages: ${pkgs.slice(0, 25).join(', ')}${pkgs.length > 25 ? '...' : ''}`);
    }
  } catch {
    /* no packages/ */
  }

  return parts.join('\n');
}
