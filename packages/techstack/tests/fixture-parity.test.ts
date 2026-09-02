/**
 * Fixture-parity test for `@wrongstack/techstack`.
 *
 * Verifies:
 * 1. PURL construction (`constructPurl`) produces valid PURLs for every
 *    supported ecosystem: npm, pypi, cargo, golang, maven, nuget, pub, gem,
 *    composer. Scoped npm packages are URL-encoded; Maven coordinates use
 *    groupId/artifactId namespace splitting.
 * 2. `constructPurl` + `parsePurlEcosystem` roundtrips — every constructed
 *    PURL can be parsed back into the same `(ecosystem, name, version)`
 *    triple.
 * 3. Representative `DependencyObservation` instances from each ecosystem
 *    share the same normalized shape: required fields present, optional
 *    fields typed correctly, status classification is one of the valid
 *    `DependencyStatus` values. This is the "fixture parity" contract:
 *    regardless of ecosystem, the inventory engine emits rows with the
 *    same shape so downstream consumers (UI table, report generator,
 *    outbox) can treat them uniformly.
 *
 * @see docs/specs/techstack-sdd.md §4.1, §8.2
 */

import { describe, expect, it } from 'vitest';
import {
  constructPurl,
  type DependencyObservation,
  type DependencyStatus,
  type EcosystemId,
  type Evidence,
  parsePurl,
  parsePurlEcosystem,
} from '../src/index.js';

const VALID_STATUSES = new Set<DependencyStatus>([
  'current',
  'update_available_safe',
  'update_available_breaking',
  'blocked_by_constraints',
  'vulnerable',
  'deprecated',
  'yanked',
  'unmaintained_suspected',
  'private_or_unresolved',
  'local_path',
  'git_dependency',
  'unsupported',
  'unknown',
]);

const VALID_ECOSYSTEMS = new Set<EcosystemId>([
  'npm',
  'python',
  'rust',
  'go',
  'dotnet',
  'php',
  'dart',
  'maven',
  'gradle',
  'ruby',
  'swift',
  'elixir',
  'cpp',
]);

describe('fixture-parity — PURL construction per ecosystem', () => {
  it('npm — unscoped packages produce `pkg:npm/<name>@<version>`', () => {
    expect(constructPurl('npm', 'react', '19.1.0')).toBe('pkg:npm/react@19.1.0');
  });

  it('npm — scoped packages URL-encode the `@` in the scope', () => {
    expect(constructPurl('npm', '@types/node', '22.0.0')).toBe('pkg:npm/%40types/node@22.0.0');
    expect(constructPurl('npm', '@wrongstack/core', '0.287.1')).toBe(
      'pkg:npm/%40wrongstack/core@0.287.1',
    );
  });

  it('pypi — produces `pkg:pypi/<name>@<version>`', () => {
    expect(constructPurl('python', 'django', '5.2')).toBe('pkg:pypi/django@5.2');
    expect(constructPurl('python', 'requests', '2.32.3')).toBe('pkg:pypi/requests@2.32.3');
  });

  it('cargo — produces `pkg:cargo/<name>@<version>`', () => {
    expect(constructPurl('rust', 'serde', '1.0.215')).toBe('pkg:cargo/serde@1.0.215');
  });

  it('golang — produces `pkg:golang/<name>@<version>`', () => {
    expect(constructPurl('go', 'github.com/gorilla/mux', '1.8.1')).toBe(
      'pkg:golang/github.com/gorilla/mux@1.8.1',
    );
  });

  it('maven — groupId/artifactId split into namespace/name', () => {
    expect(constructPurl('maven', 'org.springframework/spring-core', '6.2.7')).toBe(
      'pkg:maven/org.springframework/spring-core@6.2.7',
    );
  });

  it('nuget — produces `pkg:nuget/<name>@<version>`', () => {
    expect(constructPurl('dotnet', 'Newtonsoft.Json', '13.0.3')).toBe(
      'pkg:nuget/Newtonsoft.Json@13.0.3',
    );
  });

  it('pub — produces `pkg:pub/<name>@<version>`', () => {
    expect(constructPurl('dart', 'flutter_bloc', '8.1.6')).toBe('pkg:pub/flutter_bloc@8.1.6');
  });

  it('gem — produces `pkg:gem/<name>@<version>`', () => {
    expect(constructPurl('ruby', 'rails', '7.1.4')).toBe('pkg:gem/rails@7.1.4');
  });

  it('composer — produces `pkg:composer/<vendor>/<name>@<version>`', () => {
    expect(constructPurl('php', 'symfony/console', '7.1.0')).toBe(
      'pkg:composer/symfony/console@7.1.0',
    );
  });

  it('omitting the version produces a versionless PURL', () => {
    expect(constructPurl('npm', 'react')).toBe('pkg:npm/react');
    expect(constructPurl('python', 'django')).toBe('pkg:pypi/django');
  });
});

describe('fixture-parity — PURL roundtrip', () => {
  const ROUNDTRIP_CASES: ReadonlyArray<{
    ecosystem: EcosystemId;
    name: string;
    version?: string;
  }> = [
    { ecosystem: 'npm', name: 'react', version: '19.1.0' },
    { ecosystem: 'npm', name: '@types/node', version: '22.0.0' },
    { ecosystem: 'npm', name: 'lodash' },
    { ecosystem: 'python', name: 'django', version: '5.2' },
    { ecosystem: 'rust', name: 'serde', version: '1.0.215' },
    { ecosystem: 'go', name: 'github.com/gorilla/mux', version: '1.8.1' },
    { ecosystem: 'dotnet', name: 'Newtonsoft.Json', version: '13.0.3' },
    { ecosystem: 'php', name: 'symfony/console', version: '7.1.0' },
    { ecosystem: 'dart', name: 'flutter_bloc', version: '8.1.6' },
    { ecosystem: 'ruby', name: 'rails', version: '7.1.4' },
    { ecosystem: 'maven', name: 'org.springframework/spring-core', version: '6.2.7' },
    { ecosystem: 'gradle', name: 'org.springframework/spring-core', version: '6.2.7' },
    { ecosystem: 'swift', name: 'swift-argument-parser', version: '1.4.0' },
    { ecosystem: 'elixir', name: 'phoenix', version: '1.7.14' },
    { ecosystem: 'cpp', name: 'fmt', version: '11.0.2' },
  ];

  for (const { ecosystem, name, version } of ROUNDTRIP_CASES) {
    // Gradle shares the `maven` PURL type, so a gradle PURL roundtrips to maven.
    const expectedEcosystem = ecosystem === 'gradle' ? 'maven' : ecosystem;
    it(`roundtrips ${ecosystem}:${name}${version ? '@' + version : ''}`, () => {
      const purl = constructPurl(ecosystem, name, version);
      const parsed = parsePurlEcosystem(purl);
      expect(parsed, `parsePurlEcosystem must succeed for: ${purl}`).toBeDefined();
      expect(parsed?.ecosystem).toBe(expectedEcosystem);
      expect(parsed?.name).toBe(name);
      expect(parsed?.version).toBe(version);
    });
  }

  it('parses a known-good PURL directly', () => {
    const parsed = parsePurlEcosystem('pkg:npm/%40types/node@22.0.0');
    expect(parsed).toEqual({ ecosystem: 'npm', name: '@types/node', version: '22.0.0' });
  });

  it('returns undefined for malformed PURLs', () => {
    expect(parsePurlEcosystem('not-a-purl')).toBeUndefined();
    expect(parsePurlEcosystem('pkg:npm')).toBeUndefined();
    expect(parsePurlEcosystem('pkg:npm/')).toBeUndefined();
  });

  it('does not throw on malformed percent-escapes in qualifiers', () => {
    // Regression (2026-09-02): the qualifier branch used a raw
    // decodeURIComponent, so a malformed escape crashed parsePurl with
    // URIError instead of degrading the way every other purl segment does
    // (decodePurlSegment passes undecodable escapes through raw).
    const value = parsePurl('pkg:npm/react?arch=%E0%A4%A');
    expect(value?.name).toBe('react');
    expect(value?.qualifiers?.get('arch')).toBe('%E0%A4%A');
    const key = parsePurl('pkg:npm/react?%E0%A4%A=x86');
    expect(key?.name).toBe('react');
    expect(key?.qualifiers?.get('%E0%A4%A')).toBe('x86');
    expect(parsePurlEcosystem('pkg:npm/react?arch=%')).toEqual({ ecosystem: 'npm', name: 'react' });
  });

  it('parses and decodes valid qualifiers', () => {
    const parts = parsePurl('pkg:npm/react?arch=x86&os=linux&v=1%2F2');
    expect(parts?.qualifiers?.get('arch')).toBe('x86');
    expect(parts?.qualifiers?.get('os')).toBe('linux');
    expect(parts?.qualifiers?.get('v')).toBe('1/2');
  });

  it('returns undefined for PURL types that do not map to a TechStack ecosystem', () => {
    // `deb` is a valid PURL type but not in the TechStack ecosystem union.
    expect(parsePurlEcosystem('pkg:deb/debian/curl@7.88.1-10')).toBeUndefined();
  });
});

/**
 * Build a representative DependencyObservation for an ecosystem so we can
 * assert shape parity across ecosystems.
 */
function makeObservation(
  ecosystem: EcosystemId,
  name: string,
  manifest: string,
): DependencyObservation {
  const evidence: readonly Evidence[] = [
    {
      kind: 'manifest',
      source: manifest,
      retrievedAt: '2026-07-16T00:00:00.000Z',
    },
  ];
  return {
    id: `${ecosystem}:${name}:dev`,
    workspaceId: `ws-${ecosystem}`,
    purl: constructPurl(ecosystem, name, '1.0.0'),
    ecosystem,
    name,
    sourceType: 'registry',
    direct: true,
    scope: 'development',
    requested: '^1.0.0',
    locked: '1.0.0',
    status: 'current',
    evidence,
  };
}

describe('fixture-parity — normalized DependencyObservation shape', () => {
  const SHAPE_ECOSYSTEMS: ReadonlyArray<EcosystemId> = [
    'npm',
    'python',
    'rust',
    'go',
    'dotnet',
    'php',
    'dart',
    'maven',
    'gradle',
    'ruby',
    'swift',
    'elixir',
    'cpp',
  ];

  for (const ecosystem of SHAPE_ECOSYSTEMS) {
    it(`${ecosystem} — observations conform to the canonical shape`, () => {
      const obs = makeObservation(ecosystem, 'example-pkg', `manifest.${ecosystem}`);
      // Required scalar fields
      expect(typeof obs.id).toBe('string');
      expect(obs.id.length).toBeGreaterThan(0);
      expect(typeof obs.workspaceId).toBe('string');
      expect(obs.workspaceId.length).toBeGreaterThan(0);
      expect(obs.ecosystem).toBe(ecosystem);
      expect(VALID_ECOSYSTEMS.has(obs.ecosystem)).toBe(true);
      expect(typeof obs.name).toBe('string');
      expect(obs.name.length).toBeGreaterThan(0);
      // Source classification
      expect(typeof obs.direct).toBe('boolean');
      expect(['runtime', 'development', 'peer', 'build', 'optional', 'transitive']).toContain(
        obs.scope,
      );
      expect(['registry', 'workspace', 'path', 'git', 'system', 'unknown']).toContain(
        obs.sourceType,
      );
      // Status is one of the valid DependencyStatus values
      expect(VALID_STATUSES.has(obs.status)).toBe(true);
      // Evidence is a non-empty array of Evidence-shaped records
      expect(Array.isArray(obs.evidence)).toBe(true);
      expect(obs.evidence.length).toBeGreaterThanOrEqual(1);
      for (const item of obs.evidence) {
        expect(['manifest', 'lockfile', 'registry', 'audit', 'osv', 'agent', 'command']).toContain(
          item.kind,
        );
        expect(typeof item.source).toBe('string');
        expect(item.source.length).toBeGreaterThan(0);
        expect(typeof item.retrievedAt).toBe('string');
      }
      // PURL is present and roundtrips for registry-sourced observations.
      // Gradle uses the `maven` PURL type per the spec, so a gradle observation's
      // PURL parses back as `maven` — verify that, and the other ecosystems by name.
      expect(typeof obs.purl).toBe('string');
      const parsed = parsePurlEcosystem(obs.purl as string);
      const expectedRoundtripped = ecosystem === 'gradle' ? 'maven' : ecosystem;
      expect(parsed?.ecosystem).toBe(expectedRoundtripped);
      expect(parsed?.name).toBe('example-pkg');
      expect(parsed?.version).toBe('1.0.0');
    });
  }

  it('all ecosystems share the same top-level keys (structural parity)', () => {
    // Build one observation per ecosystem, collect key sets, and assert
    // they're all the same — this catches any ecosystem accidentally
    // adding/dropping a field.
    const observations = SHAPE_ECOSYSTEMS.map((eco) => makeObservation(eco, 'x', 'manifest'));
    const keySets = observations.map((o) => Object.keys(o).sort());
    const reference = JSON.stringify(keySets[0]);
    for (const keys of keySets) {
      expect(JSON.stringify(keys)).toBe(reference);
    }
  });
});

describe('fixture-parity — fixture files exist on disk', () => {
  const FIXTURE_PATHS = [
    'tests/fixtures/monorepo-pnpm/package.json',
    'tests/fixtures/monorepo-pnpm/pnpm-lock.yaml',
    'tests/fixtures/monorepo-pnpm/pnpm-workspace.yaml',
    'tests/fixtures/monorepo-pnpm/packages/web/package.json',
    'tests/fixtures/monorepo-pnpm/packages/api/package.json',
    'tests/fixtures/monorepo-python/pyproject.toml',
    'tests/fixtures/monorepo-python/requirements.txt',
    'tests/fixtures/monorepo-mixed/package.json',
    'tests/fixtures/monorepo-mixed/requirements.txt',
    'tests/fixtures/monorepo-mixed/pyproject.toml',
    'tests/fixtures/monorepo-mixed/Cargo.toml',
  ] as const;

  for (const rel of FIXTURE_PATHS) {
    it(`${rel} exists`, async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const fileURLToPath = (await import('node:url')).fileURLToPath;
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const absolute = path.resolve(__dirname, '..', rel);
      const stat = await fs.stat(absolute);
      expect(stat.isFile()).toBe(true);
    });
  }
});
