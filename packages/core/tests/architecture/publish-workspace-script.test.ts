import { describe, expect, it } from 'vitest';
import {
  collectPublishablePackages,
  layerByDependencies,
} from '../../../../scripts/lib/publishable-packages.mjs';
import {
  checkOriginHasVersion,
  checkPublished,
  parseArgs,
  partitionLive,
} from '../../../../scripts/publish-workspace.mjs';

/** Default seam for resume tests: the origin holds nothing unless a test says so. */
const originHasNothing = async () =>
  ({ ok: false, reason: 'version missing from origin packument' }) as const;

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
        checkOriginHasVersion: originHasNothing,
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
      {
        checkPublished: async () => ({
          ok: false,
          reason: 'packument fetch failed: ECONNRESET',
        }),
        checkOriginHasVersion: async () => ({
          ok: false,
          reason: 'origin packument fetch failed: ECONNRESET',
        }),
      },
    );

    expect(live).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(['@wrongstack/core']);
  });

  it('reports a fully-published layer as nothing left to do', async () => {
    const { pending } = await partitionLive(
      [pkg('@wrongstack/persistence'), pkg('@wrongstack/primitives')],
      { registry: 'https://registry.test' },
      {
        checkPublished: async () => ({ ok: true }),
        checkOriginHasVersion: originHasNothing,
      },
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
        checkOriginHasVersion: originHasNothing,
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
    expect(result).toEqual({
      ok: false,
      reason: 'version missing from packument',
    });
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

/**
 * Regression cover for the 1.0.6 release. `@wrongstack/cli@1.0.6` was accepted
 * by npm, the CDN edge had not served it within the 300s budget, and the re-run
 * asked the edge whether the package was published. The edge said no, so the
 * script published again and npm answered
 * `409 Cannot publish over previously staged version "1.0.6"` - a hard failure
 * on a release that had already fully succeeded.
 */
describe('origin truth vs edge truth', () => {
  const pkg = (name: string) => ({ name, version: '1.0.6' });
  const edgeHasNothing = async () =>
    ({ ok: false, reason: 'version missing from packument' }) as const;

  it('does not republish a version npm already holds but has not propagated', async () => {
    const { live, staged, pending } = await partitionLive(
      [pkg('@wrongstack/cli')],
      { registry: 'https://registry.test' },
      {
        checkPublished: edgeHasNothing,
        checkOriginHasVersion: async () => ({ ok: true }),
      },
    );

    expect(pending).toEqual([]);
    expect(live).toEqual([]);
    expect(staged.map((p) => p.name)).toEqual(['@wrongstack/cli']);
  });

  it('still verifies a staged package, because npm holding it is not a user installing it', async () => {
    // `staged` is skipped by the publish step and MUST be handed to
    // verifyLayer anyway: it is exactly the not-yet-installable state that the
    // layer ordering exists to keep dependents from racing.
    const { staged, live } = await partitionLive(
      [pkg('@wrongstack/cli')],
      { registry: 'https://registry.test' },
      {
        checkPublished: edgeHasNothing,
        checkOriginHasVersion: async () => ({ ok: true }),
      },
    );

    expect(live, 'a staged package must not be reported as already proven').toEqual([]);
    expect(staged).toHaveLength(1);
  });

  it('treats an unreachable origin as not-published, so a real gap still publishes', async () => {
    // Erring the other way would skip a package that never left the machine and
    // ship a layer with a hole in it. A needless republish is recoverable; a
    // missing dependency on npm is the ETARGET outage.
    const { staged, pending } = await partitionLive(
      [pkg('@wrongstack/core')],
      { registry: 'https://registry.test' },
      {
        checkPublished: edgeHasNothing,
        checkOriginHasVersion: async () => ({
          ok: false,
          reason: 'origin packument HTTP 503',
        }),
      },
    );

    expect(staged).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(['@wrongstack/core']);
  });

  it('does not ask the origin about a package the edge already serves', async () => {
    let originCalls = 0;
    await partitionLive(
      [pkg('a')],
      { registry: 'https://registry.test' },
      {
        checkPublished: async () => ({ ok: true }),
        checkOriginHasVersion: async () => {
          originCalls += 1;
          return { ok: true };
        },
      },
    );

    expect(originCalls).toBe(0);
  });
});

describe('origin publication check', () => {
  it('bypasses the CDN edge, which is the whole reason it exists', async () => {
    const urls: string[] = [];
    const seen: RequestInit[] = [];
    const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      seen.push(init ?? {});
      return new Response(JSON.stringify({ versions: { '1.0.6': {} } }), {
        status: 200,
      });
    };

    const result = await checkOriginHasVersion('https://registry.test', '@scope/pkg', '1.0.6', {
      fetch: fetchStub as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(urls).toEqual(['https://registry.test/@scope%2fpkg?write=true']);
    expect((seen[0]!.headers as Record<string, string>)['cache-control']).toBe('no-store');
  });

  it("does not require the tarball, because propagation is verifyLayer's question", async () => {
    const methods: (string | undefined)[] = [];
    const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method);
      return new Response(JSON.stringify({ versions: { '1.0.6': {} } }), {
        status: 200,
      });
    };

    await checkOriginHasVersion('https://registry.test', 'pkg', '1.0.6', {
      fetch: fetchStub as unknown as typeof fetch,
    });

    expect(methods).not.toContain('HEAD');
  });

  it('reports a version the origin does not have as not published', async () => {
    const fetchStub = async () =>
      new Response(JSON.stringify({ versions: { '1.0.5': {} } }), {
        status: 200,
      });

    const result = await checkOriginHasVersion('https://registry.test', 'pkg', '1.0.6', {
      fetch: fetchStub as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'version missing from origin packument',
    });
  });

  it('reports a refusing origin as not published rather than throwing', async () => {
    const fetchStub = async () => {
      throw new Error('ECONNRESET');
    };

    const result = await checkOriginHasVersion('https://registry.test', 'pkg', '1.0.6', {
      fetch: fetchStub as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'origin packument fetch failed: ECONNRESET',
    });
  });
});
