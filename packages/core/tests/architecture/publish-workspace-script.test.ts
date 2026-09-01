import { describe, expect, it } from 'vitest';
import {
  collectPublishablePackages,
  layerByDependencies,
} from '../../../../scripts/lib/publishable-packages.mjs';
import { checkPublished, parseArgs } from '../../../../scripts/publish-workspace.mjs';

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
