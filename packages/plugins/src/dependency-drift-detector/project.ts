import {
  asRecord,
  type EvidenceFinding,
  type JsonRecord,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Classify one dependency spec; `null` when it is an ordinary bounded registry range. */
export function specIssue(spec: string): 'unbounded' | 'non-registry' | 'local' | null {
  const value = spec.trim();
  if (
    value === '' ||
    value === '*' ||
    value === 'latest' ||
    value === 'x' ||
    /^>=?\s*[\d.]+\s*$/.test(value)
  )
    return 'unbounded';
  if (/^(?:workspace|catalog|npm):/.test(value)) return null;
  if (/^(?:file|link|portal):/.test(value)) return 'local';
  if (
    /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:)/.test(value) ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)
  )
    return 'non-registry';
  return null;
}

/** Unbounded ranges, non-registry sources and cross-package version drift in the workspace. */
export async function collectDependencyDrift(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const rootPkg = await readJson(root, 'package.json');
  if (rootPkg === undefined) {
    throw new Error(
      'dependency_drift_analyze found no package.json at the project root; pass a manifest or install output as content instead',
    );
  }
  const manifests: Array<{ file: string; pkg: JsonRecord }> = [];
  if (rootPkg) manifests.push({ file: 'package.json', pkg: rootPkg });
  const workspaces = await resolveWorkspaces(root, rootPkg);
  for (const dir of workspaces.packages) {
    signal.throwIfAborted();
    const pkg = await readJson(root, `${dir}/package.json`);
    if (pkg) manifests.push({ file: `${dir}/package.json`, pkg });
  }
  const findings: EvidenceFinding[] = [];
  const specsByDep = new Map<string, Map<string, string[]>>();
  for (const { file, pkg } of manifests) {
    for (const field of FIELDS) {
      for (const [dep, raw] of Object.entries(asRecord(pkg[field]) ?? {})) {
        if (typeof raw !== 'string') continue;
        const issue = specIssue(raw);
        if (issue === 'unbounded') {
          findings.push({
            rule: 'unbounded dependency range',
            severity: 'warning',
            file,
            line: 0,
            excerpt: `${field}.${dep}: "${raw}"`,
            advice:
              'Use an intentional semver range or a pinned version according to project policy.',
          });
        } else if (issue === 'non-registry') {
          findings.push({
            rule: 'non-registry dependency source',
            severity: 'info',
            file,
            line: 0,
            excerpt: `${field}.${dep}: "${raw}"`,
            advice:
              'Pin git/URL dependencies to a commit or tag; they bypass registry integrity metadata.',
          });
        } else if (issue === 'local') {
          findings.push({
            rule: 'local path dependency',
            severity: 'info',
            file,
            line: 0,
            excerpt: `${field}.${dep}: "${raw}"`,
            advice: 'Confirm the path exists for every consumer; local links break when published.',
          });
        }
        if (issue !== null || /^(?:workspace|catalog):/.test(raw)) continue;
        const variants = specsByDep.get(dep) ?? new Map<string, string[]>();
        variants.set(raw, [...(variants.get(raw) ?? []), file]);
        specsByDep.set(dep, variants);
      }
    }
  }
  let drifted = 0;
  for (const [dep, variants] of specsByDep) {
    if (variants.size < 2) continue;
    // `^5.1.0` vs `5.1.0` admit the same release; only different base
    // versions can install two copies.
    const bases = new Set([...variants.keys()].map((spec) => spec.replace(/^[\^~=v\s]+/, '')));
    const styleOnly = bases.size === 1;
    if (!styleOnly) drifted += 1;
    const described = [...variants]
      .map(
        ([spec, files]) =>
          `${spec} (${files.length === 1 ? files[0] : `${files.length} packages`})`,
      )
      .join(' vs ');
    findings.push({
      rule: styleOnly ? 'range style differs across packages' : 'version drift across packages',
      severity: styleOnly ? 'info' : 'warning',
      file: [...variants.values()][0]![0]!,
      line: 0,
      excerpt: `${dep}: ${described}`.slice(0, 240),
      advice:
        'Align the range across workspace packages (or use a catalog) so one version is installed.',
    });
  }
  return {
    findings,
    inspected: manifests.map((m) => m.file),
    facts: {
      manifests: manifests.length,
      dependencies: specsByDep.size,
      driftedDependencies: drifted,
    },
    limitation:
      'Compared declared ranges in package manifests only (peerDependencies excluded); resolved lockfile versions were not read.',
  };
}
