import * as path from 'node:path';
import {
  ensureProjectDataDir,
  generateProjectSlug,
  loadManifest,
  saveManifest,
} from './projects-manifest.js';

/**
 * Idempotent manifest registration (mirrors the CLI's
 * touchProjectInManifest): create the projects.json entry when missing,
 * refresh lastSeen/lastWorkingDir when present.
 */
export async function touchProjectEntry(
  globalConfigPath: string,
  root: string,
  workDir?: string,
): Promise<void> {
  const resolved = path.resolve(root);
  const manifest = await loadManifest(globalConfigPath);
  const now = new Date().toISOString();
  const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
  if (existing) {
    existing.lastSeen = now;
    if (workDir) existing.lastWorkingDir = path.resolve(workDir);
  } else {
    manifest.projects.push({
      name: path.basename(resolved),
      root: resolved,
      slug: generateProjectSlug(resolved),
      createdAt: now,
      lastSeen: now,
      lastWorkingDir: workDir ? path.resolve(workDir) : undefined,
    });
  }
  await saveManifest(manifest, globalConfigPath);
  await ensureProjectDataDir(generateProjectSlug(resolved), globalConfigPath);
}
