import {
  asRecord,
  declaredPackageManager,
  type EvidenceFinding,
  exists,
  type JsonRecord,
  LOCKFILES,
  lockfilesIn,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

const MAX_PACKAGES = 300;

/** `"build": "bun run compile && npm run test:unit"` → [{manager:'bun',name:'compile'}, …]. */
export function referencedScripts(command: string): Array<{ manager: string; name: string }> {
  const refs: Array<{ manager: string; name: string }> = [];
  const pattern = /\b(npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:_.@-]+)/g;
  for (const match of command.matchAll(pattern)) {
    const name = match[2]!;
    // `bun run scripts/build.ts` runs a file, not a script.
    if (/[/\\]|\.[cm]?[jt]sx?$/.test(name) || name.startsWith('-')) continue;
    refs.push({ manager: match[1]!, name });
  }
  return refs;
}

/** Lowest major a simple `>=N` / `^N` / `~N` / `N.x` engine range admits; `null` if not that simple. */
export function minimumMajor(range: string): number | null {
  const match = /^\s*(?:>=?|\^|~)?\s*v?(\d+)(?:\.(?:\d+|x|\*))*\s*$/.exec(range);
  return match ? Number(match[1]) : null;
}

/** Check package-manager, engine, script and workspace contracts of the project manifests. */
export async function collectWorkspaceHealth(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const findings: EvidenceFinding[] = [];
  const rootPkg = await readJson(root, 'package.json');
  if (rootPkg === undefined) {
    throw new Error(
      'workspace_health_analyze found no package.json at the project root; pass evidence as content for non-Node projects',
    );
  }
  if (rootPkg === null) {
    findings.push({
      rule: 'unparsable manifest',
      severity: 'error',
      file: 'package.json',
      line: 0,
      excerpt: 'package.json is not valid JSON',
      advice: 'Fix the JSON syntax; every package-manager command will fail until then.',
    });
    return { findings, inspected: ['package.json'], limitation: 'Manifest could not be parsed.' };
  }
  const manager = declaredPackageManager(rootPkg);
  const lockfiles = await lockfilesIn(root, '.');
  if (manager && lockfiles.length > 0 && !lockfiles.some((name) => LOCKFILES[name] === manager)) {
    findings.push({
      rule: 'lockfile does not match packageManager',
      severity: 'error',
      file: 'package.json',
      line: 0,
      excerpt: `packageManager is ${manager} but the lockfile is ${lockfiles.join(', ')}`,
      advice:
        'Install with the declared manager (and commit its lockfile) or correct packageManager.',
    });
  }

  const engine = asRecord(rootPkg['engines'])?.['node'];
  const runtimeMajor = Number(process.versions.node.split('.')[0]);
  // Under Bun `process.versions.node` is Bun's emulated Node version, not the
  // Node the project's scripts run on, so a comparison is wrong both ways:
  // the engine range is reported as a fact instead.
  const underBun = typeof process.versions['bun'] === 'string';
  if (typeof engine === 'string' && !underBun) {
    const min = minimumMajor(engine);
    if (min !== null && runtimeMajor < min) {
      findings.push({
        rule: 'unsupported runtime',
        severity: 'error',
        file: 'package.json',
        line: 0,
        excerpt: `engines.node is "${engine}" but the active runtime reports Node ${process.versions.node}`,
        advice: 'Switch to a runtime that satisfies engines.node before running project scripts.',
      });
    }
  }

  const workspaces = await resolveWorkspaces(root, rootPkg);
  for (const pattern of workspaces.emptyPatterns) {
    findings.push({
      rule: 'workspace resolution failure',
      severity: 'error',
      file: 'package.json',
      line: 0,
      excerpt: `workspace glob "${pattern}" matches no directory with a package.json`,
      advice: 'Fix or remove the glob; a stale glob hides packages you expect to be linked.',
    });
  }
  const manifests: Array<{ dir: string; pkg: JsonRecord }> = [{ dir: '.', pkg: rootPkg }];
  for (const dir of workspaces.packages.slice(0, MAX_PACKAGES)) {
    signal.throwIfAborted();
    const pkg = await readJson(root, `${dir}/package.json`);
    if (pkg === null) {
      findings.push({
        rule: 'unparsable manifest',
        severity: 'error',
        file: `${dir}/package.json`,
        line: 0,
        excerpt: `${dir}/package.json is not valid JSON`,
        advice: 'Fix the JSON syntax before installing.',
      });
    } else if (pkg) manifests.push({ dir, pkg });
  }
  const workspaceNames = new Set(
    manifests.map((m) => m.pkg['name']).filter((n): n is string => typeof n === 'string'),
  );

  for (const { dir, pkg } of manifests) {
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const scripts = asRecord(pkg['scripts']) ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue;
      for (const { manager: runner, name: ref } of referencedScripts(command)) {
        if (ref in scripts) continue;
        // `bun run x` / `yarn run x` fall back to an installed binary or a
        // dependency's bin; only npm and pnpm require a script of that name.
        if (runner === 'bun' || runner === 'yarn') {
          const binDirs = [
            dir === '.' ? 'node_modules/.bin' : `${dir}/node_modules/.bin`,
            'node_modules/.bin',
          ];
          let installed = false;
          for (const binDir of binDirs) {
            for (const suffix of ['', '.cmd', '.exe', '.bunx']) {
              if (await exists(root, `${binDir}/${ref}${suffix}`)) installed = true;
            }
          }
          if (installed || !(await exists(root, 'node_modules'))) continue;
        }
        findings.push({
          rule: 'missing script',
          severity: 'warning',
          file,
          line: 0,
          excerpt: `script "${name}" runs "${ref}", which ${file} does not define`,
          advice: 'Add the missing script or fix the reference; this script fails when run.',
        });
      }
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = asRecord(pkg[field]) ?? {};
      for (const [dep, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && spec.startsWith('workspace:') && !workspaceNames.has(dep)) {
          findings.push({
            rule: 'workspace resolution failure',
            severity: 'error',
            file,
            line: 0,
            excerpt: `${field}.${dep} is "${spec}" but no workspace package is named ${dep}`,
            advice: 'Verify workspace globs and the dependency name.',
          });
        }
      }
    }
  }
  return {
    findings,
    inspected: manifests.map((m) => (m.dir === '.' ? 'package.json' : `${m.dir}/package.json`)),
    facts: {
      packageManager: manager,
      lockfiles,
      workspacePackages: workspaces.packages.length,
      ...(typeof engine === 'string' ? { enginesNode: engine } : {}),
      ...(underBun
        ? {
            runtimeBun: process.versions['bun'],
            engineCheck: 'skipped: Bun reports an emulated Node version',
          }
        : { runtimeNode: process.versions.node }),
    },
    limitation:
      'Read package manifests and lockfile names only; no install or script was run. Only simple engine ranges (>=N, ^N, N.x) are compared.',
  };
}
