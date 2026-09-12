import { describe, expect, it } from 'vitest';
import type { Config } from '@wrongstack/core/types';
import { integrationConnectSources } from '../src/server/http-server/integration-connect-src.js';

const cfg = (value: unknown): Config => value as Config;

describe('integrationConnectSources', () => {
  it('returns the configured HQ and WrongProxy URLs', () => {
    expect(
      integrationConnectSources(
        cfg({
          hq: { enabled: true, url: 'http://127.0.0.1:3499' },
          tools: { wrongProxy: { enabled: true, url: 'http://localhost:3444' } },
        }),
      ),
    ).toEqual(['http://127.0.0.1:3499', 'http://localhost:3444']);
  });

  it('reports a disabled integration too', () => {
    // The toggle lives in the browser and flips without a reload; the header
    // is fixed at page load. Listing the origin regardless costs nothing and
    // keeps a toggle-on from needing a refresh to stop being CSP-blocked.
    expect(integrationConnectSources(cfg({ hq: { enabled: false, url: 'http://127.0.0.1:3499' } })))
      .toEqual(['http://127.0.0.1:3499']);
  });

  it('skips empty, blank and missing URLs', () => {
    expect(integrationConnectSources(cfg({ hq: { url: '   ' }, tools: { wrongProxy: {} } }))).toEqual(
      [],
    );
    expect(integrationConnectSources(cfg({}))).toEqual([]);
    expect(integrationConnectSources(undefined)).toEqual([]);
  });

  it('ignores non-string URL values', () => {
    expect(
      integrationConnectSources(cfg({ hq: { url: 1234 }, tools: { wrongProxy: { url: null } } })),
    ).toEqual([]);
  });
});
