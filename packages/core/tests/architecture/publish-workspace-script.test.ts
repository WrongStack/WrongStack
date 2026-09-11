import { describe, expect, it } from 'vitest';
import {
  collectPublishablePackages,
  layerByDependencies,
} from '../../../../scripts/lib/publishable-packages.mjs';
import {
  checkPublished,
  parseArgs,
  partitionLive,
} from '../../../../scripts/publish-workspace.mjs';

/**
 * Regression cover for the 0.317.2 release, where `pnpm publish -r` let the
 * registry observe `wrongstack@0.317.2` 25 seconds BEFORE its transitive
 * dependency `@wrongstack/webui-hq@0.317.2`, so `npm i -g wrongstack` failed
 * with ETARGET for everyone who installed inside that window.
 */
describe('publish dependency layering', () => {
  it('never places a package in the same layer as, or before, a dependency', () => {
    const { publishable } = collectPublishablePackages();
    const { layers, cycles } = layerByDependencies(publishable);

    expect(cycles).toEqual([]);

    const layerOf = new Map<string, number>();
    layers.forEach((layer, index) => {
      for (const pkg of layer) layerOf.set(pkg.name, index);
    });

    for (const pkg of publishable) {
      for (const dep of pkg.workspaceDeps) {
        expect(
          layerOf.get(dep),
          `${pkg.name} (layer ${layerOf.get(pkg.name)}) depends on ${dep} (layer ${layerOf.get(dep)})`,
        ).toBeLessThan(layerOf.get(pkg.name) as number);
      }
    }
  });

  it('publishes the `wrongstack` install target after every package it pulls in', () => {
    const { publishable } = collectPublishablePackages();
    const { layers } = layerByDependencies(publishable);
    const layerOf = new Map<string, number>();
    layers.forEach((layer, index) => {
      for (const pkg of layer) layerOf.set(pkg.name, index);
    });

    const rootLayer = layerOf.get('wrongstack');
    expect(rootLayer).toBe(layers.length - 1);
    // The exact edge that broke: root -> cli -> webui-hq.
    expect(layerOf.get('@wrongstack/cli') as number).toBeLessThan(rootLayer as number);
    expect(layerOf.get('@wrongstack/webui-hq') as number).toBeLessThan(
      layerOf.get('@wrongstack/cli') as number,
    );
  });

  it('emits a cycle report instead of silently dropping packages', () => {
    const cyclic = [
      {
        name: 'a',
        version: '1.0.0',
        dir: '',
        access: 'public',
        provenance: false,
        workspaceDeps: ['b'],
      },
      {
        name: 'b',
        version: '1.0.0',
        dir: '',
        access: 'public',
        provenance: false,
        workspaceDeps: ['a'],
      },
      {
        name: 'c',
        version: '1.0.0',
        dir: '',
        access: 'public',
        provenance: false,
        workspaceDeps: [],
      },
    ];
    const { layers, cycles } = layerByDependencies(cyclic);
    expect(cycles).toEqual(['a', 'b']);
    expect(
      layers
        .flat()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('publish-workspace argument parsing', () => {
  it('verifies by default, so a release cannot skip the ordering proof by accident', () => {
    const options = parseArgs([]);
    expect(options.verify).toBe(true);
    expect(options.dryRun).toBe(false);
    expect(options.registry).toBe('https://registry.npmjs.org');
  });

  it('routes arguments after `--` to pnpm rather than parsing them as its own', () => {
    const options = parseArgs(['--dry-run', '--', '--no-git-checks', '--force']);
    expect(options.dryRun).toBe(true);
    expect(options.passthrough).toEqual(['--no-git-checks', '--force']);
  });

  it('rejects unknown flags and malformed durations', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--verify-timeout', 'abc'])).toThrow(/Invalid value/);
    expect(() => parseArgs(['--registry'])).toThrow(/Missing value/);
  });
});

/**
 * Regression cover for the 1.0.5 release, which reached layer 8 of 10 and then
 * stalled. Re-running published nothing: `pnpm publish` per-package through
 * `--filter` does not skip a version npm already serves, so layer 1 exited
 * non-zero on E403 and the only apparent recovery was a version bump - turning
 * 5 remaining publishes into 36 and stranding a half-published 1.0.5 on npm.
 */
describe('partial-release resume', () => {
  const pkg = (name: string) => ({ name, version: '1.0.5' });

  it('publishes only what the registry does not already serve', async () => {
    const live = new Set(['@wrongstack/tui', '@wrongstack/webui']);
    const { live: skipped, pending } = await partitionLive(
      [pkg('@wrongstack/tui'), pkg('@wrongstack/webui'), pkg('@wrongstack/webui-server')],
      { registry: 'https://registry.test' },
      {
        checkPublished: async (_registry, name) =>
          live.has(name) ? { ok: true } : { ok: false, reason: 'version missing from packument' },
      },
    );

    expect(pending.map((p) => p.name)).toEqual(['@wrongstack/webui-server']);
    expect(skipped.map((p) => p.name)).toEqual(['@wrongstack/tui', '@wrongstack/webui']);
  });

  it('treats an unreachable registry as not-published rather than as published', async () => {
    // Erring the other way would silently skip a package and ship a layer with
    // a hole in it - the ETARGET failure this script exists to prevent.
    const { live, pending } = await partitionLive(
      [pkg('@wrongstack/core')],
      { registry: 'https://registry.test' },
      { checkPublished: async () => ({ ok: false, reason: 'packument fetch failed: ECONNRESET' }) },
    );

    expect(live).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(['@wrongstack/core']);
  });

  it('reports a fully-published layer as nothing left to do', async () => {
    const { pending } = await partitionLive(
      [pkg('@wrongstack/persistence'), pkg('@wrongstack/primitives')],
      { registry: 'https://registry.test' },
      { checkPublished: async () => ({ ok: true }) },
    );

    expect(pending).toEqual([]);
  });

  it('preserves layer order, so the resumed publish keeps the dependency plan', async () => {
    const layer = [pkg('a'), pkg('b'), pkg('c'), pkg('d')];
    const { pending } = await partitionLive(
      layer,
      { registry: 'https://registry.test' },
      {
        checkPublished: async (_registry, name) =>
          name === 'b' ? { ok: true } : { ok: false, reason: 'version missing from packument' },
      },
    );

    expect(pending.map((p) => p.name)).toEqual(['a', 'c', 'd']);
  });
});

describe('registry publication check', () => {
  const packument = (versions: Record<string, unknown>) =>
    new Response(JSON.stringify({ versions }), { status: 200 });

  it('treats a version missing from the packument as not published', async () => {
    const fetchStub = async () => packument({ '1.0.0': { dist: { tarball: 'https://x/t.tgz' } } });
    const result = await checkPublished('https://registry.test', 'pkg', '2.0.0', {
      fetch: fetchStub as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'version missing from packument' });
  });

  it('requires the tarball to be servable, not just the metadata to exist', async () => {
    const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return packument({ '2.0.0': { dist: { tarball: 'https://x/t.tgz' } } });
    };
    const result = await checkPublished('https://registry.test', 'pkg', '2.0.0', {
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'tarball HTTP 404' });
  });

  it('passes once both the packument entry and the tarball are live', async () => {
    const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return packument({ '2.0.0': { dist: { tarball: 'https://x/t.tgz' } } });
    };
    const result = await checkPublished('https://registry.test', 'pkg', '2.0.0', {
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
  });

  it('asks the CDN edge to revalidate so it reports what a user would be served', async () => {
    const seen: RequestInit[] = [];
    const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return packument({ '2.0.0': { dist: { tarball: 'https://x/t.tgz' } } });
    };
    await checkPublished('https://registry.test', '@scope/pkg', '2.0.0', {
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(seen[0]).toBeDefined();
    const headers = seen[0]!.headers as Record<string, string>;
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers.accept).toBe('application/vnd.npm.install-v1+json');
  });

  it('encodes the scope separator the registry expects', async () => {
    const urls: string[] = [];
    const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      return packument({ '2.0.0': { dist: { tarball: 'https://x/t.tgz' } } });
    };
    await checkPublished('https://registry.test', '@scope/pkg', '2.0.0', {
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(urls[0]).toBe('https://registry.test/@scope%2fpkg');
  });
});
