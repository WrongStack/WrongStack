import {
  asRecord,
  declaredPackageManager,
  type EvidenceFinding,
  gitRead,
  LOCKFILES,
  lockfilesIn,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

function hasDependencies(pkg: Record<string, unknown> | null | undefined): boolean {
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(
    (field) => Object.keys(asRecord(pkg?.[field]) ?? {}).length > 0,
  );
}

/** Lockfile presence, ownership, nesting and git tracking for the project. */
export async function collectLockfileConsistency(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const findings: EvidenceFinding[] = [];
  const rootPkg = await readJson(root, 'package.json');
  if (rootPkg === undefined) {
    throw new Error(
      'lockfile_consistency_analyze found no package.json at the project root; pass lockfile or install output as content instead',
    );
  }
  const manager = declaredPackageManager(rootPkg);
  const lockfiles = await lockfilesIn(root, '.');
  const managers = [...new Set(lockfiles.map((name) => LOCKFILES[name]))];
  if (managers.length > 1) {
    findings.push({
      rule: 'multiple lockfiles',
      severity: 'warning',
      file: lockfiles.join(', '),
      line: 0,
      excerpt: `lockfiles from ${managers.join(' and ')}: ${lockfiles.join(', ')}`,
      advice: 'Keep only the lockfile owned by the selected package manager.',
    });
  }
  if (lockfiles.includes('bun.lock') && lockfiles.includes('bun.lockb')) {
    findings.push({
      rule: 'stale binary bun lockfile',
      severity: 'info',
      file: 'bun.lockb',
      line: 0,
      excerpt: 'both bun.lock and bun.lockb exist; Bun reads the text bun.lock',
      advice: 'Delete bun.lockb once bun.lock is committed so reviews see one source of truth.',
    });
  }
  if (manager && lockfiles.length > 0 && !managers.includes(manager)) {
    findings.push({
      rule: 'lockfile does not match packageManager',
      severity: 'error',
      file: 'package.json',
      line: 0,
      excerpt: `packageManager is ${manager}; lockfile(s): ${lockfiles.join(', ')}`,
      advice: `Regenerate the lockfile with ${manager} and remove the foreign one.`,
    });
  }
  if (lockfiles.length === 0 && hasDependencies(rootPkg)) {
    findings.push({
      rule: 'missing lockfile',
      severity: 'warning',
      file: 'package.json',
      line: 0,
      excerpt: 'dependencies are declared but no lockfile exists at the project root',
      advice:
        'Install once and commit the lockfile so CI and teammates resolve identical versions.',
    });
  }
  const workspaces = await resolveWorkspaces(root, rootPkg);
  for (const dir of workspaces.packages) {
    signal.throwIfAborted();
    const nested = await lockfilesIn(root, dir);
    if (nested.length > 0) {
      findings.push({
        rule: 'nested workspace lockfile',
        severity: 'warning',
        file: `${dir}/${nested[0]}`,
        line: 0,
        excerpt: `workspace package ${dir} has its own ${nested.join(', ')}`,
        advice: 'Workspace members resolve from the root lockfile; delete the nested one.',
      });
    }
  }
  let tracking: Record<string, boolean> | undefined;
  if (lockfiles.length > 0) {
    const tracked = await gitRead(root, ['ls-files', '--', ...lockfiles], signal);
    if (tracked !== null) {
      const set = new Set(
        tracked
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      tracking = Object.fromEntries(lockfiles.map((name) => [name, set.has(name)]));
      for (const name of lockfiles) {
        if (!set.has(name) && LOCKFILES[name] === (manager ?? LOCKFILES[name])) {
          findings.push({
            rule: 'lockfile not committed',
            severity: 'warning',
            file: name,
            line: 0,
            excerpt: `${name} exists but is not tracked by git`,
            advice: 'Commit the lockfile (check .gitignore) so installs are reproducible.',
          });
        }
      }
    }
  }
  return {
    findings,
    inspected: ['package.json', ...lockfiles, ...(tracking ? ['git ls-files'] : [])],
    facts: { packageManager: manager, lockfiles, ...(tracking ? { tracked: tracking } : {}) },
    limitation:
      'Checked lockfile names, packageManager and git tracking only; lockfile contents were not resolved against the registry.',
  };
}
