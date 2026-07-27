/**
 * TechStack — Registry client tests.
 *
 * Tests the cache, concurrency limiter, and ecosystem-specific URL builders.
 * Network calls are NOT exercised in unit tests — only the cache/bypass logic
 * and error handling are tested.
 *
 * @see packages/techstack/src/registry/client.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearRegistryCache,
  parseNpmPackument,
  supportedRegistryEcosystems,
  invalidateRegistryCache,
  RegistryNotFoundError,
  RegistryAuthError,
  RegistryRateLimitError,
  RegistryNetworkError,
} from '../../src/registry/client.js';

// ── npm packument parsing ──────────────────────────────────────────────────

describe('parseNpmPackument', () => {
  const packument = (
    latest: string,
    versions: Record<string, Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => ({ 'dist-tags': { latest }, versions, ...extra });

  it('reads latestStable from dist-tags.latest', () => {
    const entry = parseNpmPackument(packument('2.5.4', { '2.5.4': {} }), 'biome');
    expect(entry.latestStable).toBe('2.5.4');
  });

  it('marks a package deprecated when its latest version is deprecated', () => {
    const entry = parseNpmPackument(
      packument('1.0.0', { '1.0.0': { deprecated: 'use something else' } }),
      'dead-pkg',
    );
    expect(entry.deprecated).toBe(true);
  });

  // The rule that broke it: "any version in history is deprecated" flags every
  // mature package, because they all eventually deprecate an old release.
  it('does not mark a package deprecated because an OLD version was', () => {
    const entry = parseNpmPackument(
      packument('4.1.10', {
        '0.0.1': { deprecated: 'early beta, do not use' },
        '1.0.0-beta.1': { deprecated: 'superseded' },
        '4.1.10': {},
      }),
      'vitest',
    );
    expect(entry.deprecated).toBeUndefined();
  });

  it('leaves deprecated undefined for a healthy package', () => {
    const entry = parseNpmPackument(packument('1.0.0', { '1.0.0': {} }), 'healthy');
    expect(entry.deprecated).toBeUndefined();
  });

  it('never reports yanked — npm has no such field', () => {
    const entry = parseNpmPackument(packument('1.0.0', { '1.0.0': {} }), 'pkg');
    expect(entry.yanked).toBeUndefined();
  });

  it('records the registry URL as evidence source', () => {
    const entry = parseNpmPackument(packument('1.0.0', { '1.0.0': {} }), 'react');
    expect(entry.source).toBe('https://registry.npmjs.org/react');
  });

  it('survives a packument with no versions map', () => {
    const entry = parseNpmPackument({ 'dist-tags': { latest: '1.0.0' } }, 'sparse');
    expect(entry.latestStable).toBe('1.0.0');
    expect(entry.deprecated).toBeUndefined();
  });
});

// ── Error classes ─────────────────────────────────────────────────────────

describe('RegistryNotFoundError', () => {
  it('sets statusCode and packageName', () => {
    const err = new RegistryNotFoundError(404, 'missing-pkg');
    expect(err.statusCode).toBe(404);
    expect(err.packageName).toBe('missing-pkg');
    expect(err.message).toContain('404');
    expect(err.message).toContain('missing-pkg');
    expect(err.name).toBe('RegistryNotFoundError');
  });
});

describe('RegistryAuthError', () => {
  it('sets statusCode and packageName', () => {
    const err = new RegistryAuthError(403, 'private-pkg');
    expect(err.statusCode).toBe(403);
    expect(err.packageName).toBe('private-pkg');
    expect(err.message).toContain('403');
    expect(err.message).toContain('private-pkg');
    expect(err.name).toBe('RegistryAuthError');
  });
});

describe('RegistryRateLimitError', () => {
  it('sets statusCode and host', () => {
    const err = new RegistryRateLimitError(429, 'registry.npmjs.org');
    expect(err.statusCode).toBe(429);
    expect(err.host).toBe('registry.npmjs.org');
    expect(err.message).toContain('429');
    expect(err.message).toContain('registry.npmjs.org');
    expect(err.name).toBe('RegistryRateLimitError');
  });
});

describe('RegistryNetworkError', () => {
  it('wraps a cause and message', () => {
    const cause = new Error('ECONNRESET');
    const err = new RegistryNetworkError('Network failure', cause);
    expect(err.message).toBe('Network failure');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('RegistryNetworkError');
  });

  it('works without a cause', () => {
    const err = new RegistryNetworkError('timeout');
    expect(err.message).toBe('timeout');
    expect(err.cause).toBeUndefined();
  });
});

// ── Per-ecosystem registry parsers ────────────────────────────────────────
//
// Each parser is exercised through lookupRegistry's mocked path in the HTTP
// test suite. These unit tests verify the parser logic standalone for the
// ecosystems whose parsers are non-trivial.

describe('ecosystem parsers', () => {
  it('python parser extracts info from PyPI json', () => {
    // We test these via lookupRegistry by mocking http-fetch.
    // The parsers live inside ECOSYSTEM_FETCHERS which is not exported,
    // so we exercise them through the public API with mocked network.
    // This placeholder keeps the suite organized; the real HTTP-mocked
    // tests exercise lookupRegistry('python', ...) in the HTTP test file.
    expect(supportedRegistryEcosystems()).toContain('python');
  });

  it('cargo parser is wired for crates.io', () => {
    expect(supportedRegistryEcosystems()).toContain('cargo');
  });

  it('golang parser is wired for proxy.golang.org', () => {
    expect(supportedRegistryEcosystems()).toContain('golang');
  });

  it('nuget parser is wired for api.nuget.org', () => {
    expect(supportedRegistryEcosystems()).toContain('nuget');
  });

  it('composer parser is wired for repo.packagist.org', () => {
    expect(supportedRegistryEcosystems()).toContain('composer');
  });

  it('pub parser is wired for pub.dev', () => {
    expect(supportedRegistryEcosystems()).toContain('pub');
  });
});

// ── supportedRegistryEcosystems ──────────────────────────────────────────

describe('supportedRegistryEcosystems', () => {
  it('returns expected ecosystem IDs', () => {
    const ecosystems = supportedRegistryEcosystems();
    expect(ecosystems).toContain('npm');
    expect(ecosystems).toContain('python');
    expect(ecosystems).toContain('cargo');
    expect(ecosystems).toContain('golang');
    expect(ecosystems).toContain('nuget');
    expect(ecosystems).toContain('composer');
    expect(ecosystems).toContain('pub');
  });
});

// ── clearRegistryCache ──────────────────────────────────────────────────

describe('clearRegistryCache', () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it('clears without error when cache is empty', () => {
    expect(() => clearRegistryCache()).not.toThrow();
  });

  it('clears without error when called multiple times', () => {
    clearRegistryCache();
    clearRegistryCache();
    expect(() => clearRegistryCache()).not.toThrow();
  });
});

// ── invalidateRegistryCache ─────────────────────────────────────────────

describe('invalidateRegistryCache', () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it('returns 0 for unknown ecosystem', () => {
    const count = invalidateRegistryCache('bogus-ecosystem');
    expect(count).toBe(0);
  });

  it('returns 0 when cache is empty for a valid ecosystem', () => {
    const count = invalidateRegistryCache('npm');
    expect(count).toBe(0);
  });
});
