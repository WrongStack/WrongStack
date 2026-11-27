import {
  asRecord,
  type EvidenceFinding,
  gitRead,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  readText,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Working tree, version alignment, changelog, tag and upstream state before a release. */
export async function collectReleaseReadiness(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const findings: EvidenceFinding[] = [];
  const inspected: string[] = [];
  const rootPkg = await readJson(root, 'package.json');
  const version = typeof rootPkg?.['version'] === 'string' ? (rootPkg['version'] as string) : null;
  if (rootPkg !== undefined) inspected.push('package.json');

  const status = await gitRead(
    root,
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    signal,
  );
  if (status === null) {
    throw new Error(
      'release_readiness_analyze could not read `git status` (not a git repository or git unavailable); pass release-gate output as content instead',
    );
  }
  inspected.push('git status');
  const dirty = status.split('\n').filter((line) => line.trim() !== '');
  if (dirty.length > 0) {
    findings.push({
      rule: 'dirty worktree',
      severity: 'warning',
      file: '.',
      line: 0,
      excerpt: `${dirty.length} uncommitted path(s): ${dirty
        .slice(0, 6)
        .map((line) => line.slice(3))
        .join(', ')}${dirty.length > 6 ? ', …' : ''}`,
      advice:
        'Commit or set aside the pending files before tagging; a release must come from a clean tree.',
    });
  }

  // Version alignment: flag the packages that disagree with the version most
  // publishable packages share (a lockstep monorepo), not every package of an
  // independently versioned one.
  const versions = new Map<string, string[]>();
  if (rootPkg) {
    for (const dir of (await resolveWorkspaces(root, rootPkg)).packages) {
      signal.throwIfAborted();
      const pkg = await readJson(root, `${dir}/package.json`);
      if (!pkg || typeof pkg['version'] !== 'string') continue;
      if (pkg['private'] === true && !asRecord(pkg['publishConfig'])) continue;
      const list = versions.get(pkg['version'] as string) ?? [];
      list.push(dir);
      versions.set(pkg['version'] as string, list);
    }
  }
  const total = [...versions.values()].reduce((sum, dirs) => sum + dirs.length, 0);
  const [majorityVersion, majorityDirs] = [...versions].sort(
    (a, b) => b[1].length - a[1].length,
  )[0] ?? [null, []];
  const lockstep = total >= 2 && majorityDirs.length / total > 0.5;
  const canonical = lockstep ? majorityVersion : version;
  if (lockstep) {
    for (const [other, dirs] of versions) {
      if (other === majorityVersion) continue;
      for (const dir of dirs) {
        findings.push({
          rule: 'version mismatch',
          severity: 'error',
          file: `${dir}/package.json`,
          line: 0,
          excerpt: `${dir} is ${other}; ${majorityDirs.length} other package(s) are ${majorityVersion}`,
          advice: 'Align release manifests from the canonical version source before publishing.',
        });
      }
    }
    if (version && version !== majorityVersion) {
      findings.push({
        rule: 'version mismatch',
        severity: 'error',
        file: 'package.json',
        line: 0,
        excerpt: `root package.json is ${version}; workspace packages are ${majorityVersion}`,
        advice: 'Align the root version with the packages it releases.',
      });
    }
  }

  if (canonical) {
    const changelog =
      (await readText(root, 'CHANGELOG.md')) ?? (await readText(root, 'changelog.md'));
    if (changelog !== null) {
      inspected.push('CHANGELOG.md');
      const heading = new RegExp(`^#{1,3}\\s*\\[?v?${escapeRegExp(canonical)}\\]?(?:\\s|$)`, 'm');
      if (!heading.test(changelog)) {
        findings.push({
          rule: 'changelog entry missing',
          severity: 'warning',
          file: 'CHANGELOG.md',
          line: 0,
          excerpt: `no heading for ${canonical} in CHANGELOG.md`,
          advice: 'Move the [Unreleased] notes under the version being released.',
        });
      }
    }
    const tag = (
      await gitRead(root, ['tag', '--list', `v${canonical}`, canonical], signal)
    )?.trim();
    if (tag) {
      const ahead = (
        await gitRead(root, ['rev-list', '--count', `${tag.split('\n')[0]}..HEAD`], signal)
      )?.trim();
      if (ahead && Number(ahead) > 0) {
        findings.push({
          rule: 'version already released',
          severity: 'warning',
          file: 'package.json',
          line: 0,
          excerpt: `tag ${tag.split('\n')[0]} exists and HEAD is ${ahead} commit(s) past it`,
          advice: 'Bump the version before publishing; this version number is already taken.',
        });
      }
    }
  }

  const behind = (
    await gitRead(root, ['rev-list', '--count', 'HEAD..@{upstream}'], signal)
  )?.trim();
  const ahead = (await gitRead(root, ['rev-list', '--count', '@{upstream}..HEAD'], signal))?.trim();
  if (behind && Number(behind) > 0) {
    findings.push({
      rule: 'branch behind upstream',
      severity: 'warning',
      file: '.',
      line: 0,
      excerpt: `HEAD is ${behind} commit(s) behind its upstream`,
      advice:
        'Fetch and integrate upstream before releasing so the release contains what was pushed.',
    });
  }
  return {
    findings,
    inspected,
    facts: {
      version: canonical,
      dirtyPaths: dirty.length,
      ...(ahead !== undefined && ahead !== '' ? { unpushedCommits: Number(ahead) } : {}),
      versioning: lockstep ? 'lockstep' : total >= 2 ? 'independent' : 'single',
    },
    limitation:
      'Read-only git status/tag/rev-list and manifest reads; release gates (build, tests, publish dry-run) were not run.',
  };
}
