import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectFindings,
  expandWorkspaceMembers,
  findBackslashSpecsInManifest,
  parseOverrideSpecs,
  parseWorkspacePackages,
} from '../../../../scripts/check-dep-path-separators.mjs';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wstack-dep-paths-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeMember(root: string, relativeDir: string, manifest: Record<string, unknown>): void {
  const memberDir = path.join(root, relativeDir);
  mkdirSync(memberDir, { recursive: true });
  writeFileSync(path.join(memberDir, 'package.json'), JSON.stringify(manifest, null, 2));
}

describe('findBackslashSpecsInManifest', () => {
  const file = 'package.json';

  it('flags a backslash in every dependency section', () => {
    const findings = findBackslashSpecsInManifest(file, {
      dependencies: { wrongstack: 'link:apps\\wrongstack' },
      devDependencies: { tooling: 'file:../tools\\dist' },
      optionalDependencies: { native: 'portal:./vendor\\native' },
      peerDependencies: { peer: 'workspace:..\\sibling' },
    });
    expect(findings).toEqual([
      'package.json dependencies.wrongstack: "link:apps\\wrongstack"',
      'package.json devDependencies.tooling: "file:../tools\\dist"',
      'package.json optionalDependencies.native: "portal:./vendor\\native"',
      'package.json peerDependencies.peer: "workspace:..\\sibling"',
    ]);
  });

  it('flags backslashes in the pnpm.overrides block', () => {
    const findings = findBackslashSpecsInManifest(file, {
      pnpm: { overrides: { wrongstack: 'link:apps\\wrongstack' } },
    });
    expect(findings).toEqual(['package.json pnpm.overrides.wrongstack: "link:apps\\wrongstack"']);
  });

  it('accepts forward-slash and registry specs without findings', () => {
    expect(
      findBackslashSpecsInManifest(file, {
        dependencies: { wrongstack: 'link:apps/wrongstack' },
        devDependencies: { typescript: '^7.0.2' },
        peerDependencies: { react: 'workspace:*' },
      }),
    ).toEqual([]);
  });

  it('ignores malformed sections instead of throwing', () => {
    expect(findBackslashSpecsInManifest(file, { dependencies: null })).toEqual([]);
    expect(findBackslashSpecsInManifest(file, { dependencies: ['not', 'a', 'map'] })).toEqual([]);
    expect(findBackslashSpecsInManifest(file, {})).toEqual([]);
  });
});

describe('parseWorkspacePackages', () => {
  it('extracts the packages list and stops at the next top-level key', () => {
    const entries = parseWorkspacePackages(
      [
        '# leading comment',
        'packages:',
        '  - "packages/*"',
        '  - "apps/*"',
        '  - website',
        '',
        'overrides:',
        '  wrongstack: link:apps/wrongstack',
      ].join('\n'),
    );
    expect(entries).toEqual(['packages/*', 'apps/*', 'website']);
  });

  it('returns empty when there is no packages block', () => {
    expect(parseWorkspacePackages('overrides:\n  foo: bar\n')).toEqual([]);
  });
});

describe('parseOverrideSpecs', () => {
  it('extracts override name/spec pairs from the overrides block', () => {
    const overrides = parseOverrideSpecs(
      [
        'packages:',
        '  - "packages/*"',
        'overrides:',
        '  # dompurify advisory pins',
        '  dompurify: "3.4.13"',
        '  wrongstack: link:apps/wrongstack',
        '',
        'peerDependencyRules:',
        '  allowedVersions:',
        '    react: "^19"',
      ].join('\n'),
    );
    expect(overrides).toContainEqual({ name: 'dompurify', spec: '3.4.13' });
    expect(overrides).toContainEqual({ name: 'wrongstack', spec: 'link:apps/wrongstack' });
    // The subsequent top-level block must terminate the scan.
    expect(overrides).toHaveLength(2);
  });

  it('returns empty when there is no overrides block', () => {
    expect(parseOverrideSpecs('packages:\n  - "packages/*"\n')).toEqual([]);
  });
});

describe('expandWorkspaceMembers', () => {
  it('expands single-segment wildcards and keeps literal entries, root first', () => {
    const root = makeFixture('expand');
    mkdirSync(path.join(root, 'packages', 'alpha'), { recursive: true });
    mkdirSync(path.join(root, 'packages', 'beta'), { recursive: true });
    mkdirSync(path.join(root, 'packages', '.hidden-skipped'), { recursive: true });
    writeMember(root, 'website', { name: 'website' });

    const members = expandWorkspaceMembers(root, ['packages/*', 'website']).map((member: string) =>
      path.relative(root, member).replaceAll('\\', '/'),
    );
    expect(members[0]).toBe('');
    expect(members).toContain('packages/alpha');
    expect(members).toContain('packages/beta');
    expect(members).toContain('website');
    expect(members.some((member: string) => member.includes('.hidden-skipped'))).toBe(false);
  });
});

describe('collectFindings (end to end)', () => {
  it('catches backslash link specs in member manifests and workspace overrides', () => {
    const root = makeFixture('e2e');
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - "packages/*"',
        'overrides:',
        '  wrongstack: link:apps\\wrongstack',
        '',
      ].join('\n'),
    );
    // Root manifest carries the original bug shape.
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { wrongstack: 'link:apps\\wrongstack' } }),
    );
    writeMember(root, 'packages/alpha', {
      name: 'alpha',
      dependencies: { sibling: 'link:..\\beta' },
    });
    writeMember(root, 'packages/beta', { name: 'beta', devDependencies: { ts: '^7.0.2' } });

    const findings = collectFindings(root);
    expect(findings).toContain('package.json dependencies.wrongstack: "link:apps\\wrongstack"');
    expect(findings).toContain('packages/alpha/package.json dependencies.sibling: "link:..\\beta"');
    expect(findings).toContain('pnpm-workspace.yaml overrides.wrongstack: "link:apps\\wrongstack"');
    // The clean member produces no finding (match its manifest path — the
    // alpha finding's spec text itself contains "beta" via `link:..\beta`).
    expect(findings.some((finding: string) => finding.includes('packages/beta/'))).toBe(false);
  });

  it('returns no findings for an all-forward-slash workspace', () => {
    const root = makeFixture('clean');
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - "packages/*"',
        'overrides:',
        '  wrongstack: link:apps/wrongstack',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { wrongstack: 'link:apps/wrongstack' } }),
    );
    writeMember(root, 'packages/alpha', { name: 'alpha', dependencies: { beta: 'workspace:*' } });

    expect(collectFindings(root)).toEqual([]);
  });
});
