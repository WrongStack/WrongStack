import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gradleAdapter } from '../../src/adapters/gradle.js';
import { swiftAdapter } from '../../src/adapters/swift.js';
import type { EcosystemId, Workspace } from '../../src/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  ecosystem: EcosystemId,
  files: Record<string, string>,
  manifests: string[],
  lockfiles: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), `techstack-${ecosystem}-`));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  const workspace: Workspace = {
    id: `ws-${ecosystem}`,
    relativeRoot: '.',
    ecosystem,
    manifests: manifests.map((name) => join(root, name)),
    lockfiles: lockfiles.map((name) => join(root, name)),
    confidence: 1,
    coverage: 'partial',
  };
  return { root, workspace };
}

describe('GradleAdapter', () => {
  it('parses DSL coordinates, version catalogs, lockfiles, and transitives', async () => {
    const { root, workspace } = fixture(
      'gradle',
      {
        'build.gradle.kts':
          'dependencies { implementation("org.slf4j:slf4j-api:2.0.12")\ntestImplementation(libs.junit.jupiter) }',
        'gradle/libs.versions.toml':
          '[versions]\njunit = "5.10.2"\n[libraries]\njunit-jupiter = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }',
        'gradle.lockfile':
          'org.slf4j:slf4j-api:2.0.13=runtimeClasspath\norg.junit.jupiter:junit-jupiter:5.10.2=testRuntimeClasspath\ncom.google.guava:guava:33.2.1-jre=runtimeClasspath\n',
      },
      ['build.gradle.kts'],
      ['gradle.lockfile'],
    );
    const deps = await gradleAdapter.inventory(workspace, {
      projectRoot: root,
      includeTransitive: true,
    });
    expect(deps.find((dep) => dep.name === 'org.slf4j:slf4j-api')?.locked).toBe('2.0.13');
    expect(deps.find((dep) => dep.name === 'org.junit.jupiter:junit-jupiter')?.scope).toBe(
      'development',
    );
    expect(deps.find((dep) => dep.name === 'com.google.guava:guava')?.direct).toBe(false);
  });
});

describe('SwiftAdapter', () => {
  it('parses Package.swift, Package.resolved, revisions, and transitives', async () => {
    const { root, workspace } = fixture(
      'swift',
      {
        'Package.swift':
          '.package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.2.0")',
        'Package.resolved': JSON.stringify({
          version: 2,
          pins: [
            {
              identity: 'swift-argument-parser',
              location: 'https://github.com/apple/swift-argument-parser.git',
              state: { version: '1.3.0', revision: 'abc' },
            },
            {
              identity: 'swift-log',
              location: 'https://github.com/apple/swift-log.git',
              state: { revision: 'def' },
            },
          ],
        }),
      },
      ['Package.swift'],
      ['Package.resolved'],
    );
    const deps = await swiftAdapter.inventory(workspace, {
      projectRoot: root,
      includeTransitive: true,
    });
    expect(deps.find((dep) => dep.name === 'swift-argument-parser')?.locked).toBe('1.3.0');
    expect(deps.find((dep) => dep.name === 'swift-log')?.direct).toBe(false);
    expect(deps.find((dep) => dep.name === 'swift-log')?.purl).toContain('pkg:swift/swift-log@def');
  });
});
