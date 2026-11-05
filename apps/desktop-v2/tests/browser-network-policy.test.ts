import { describe, expect, it } from 'vitest';
import { browserPolicyState } from '../src/BrowserNetworkPolicy';

describe('browser and network access', () => {
  it('reads the setup line and allowed origins from the status text', () => {
    expect(
      browserPolicyState(
        'Chromium is installed.\nAllowed private origins: http://localhost:3000, loopback\n/browser help',
      ),
    ).toEqual({
      setup: 'Chromium is installed.',
      kind: 'other',
      origins: ['http://localhost:3000', 'loopback'],
    });
    expect(
      browserPolicyState('Chromium missing.\nAllowed private origins: (none)\nhelp').origins,
    ).toEqual([]);
    expect(
      browserPolicyState(
        'Network project policy saved. Allowed private origins: http://127.0.0.1:8080.',
      ).origins,
    ).toEqual(['http://127.0.0.1:8080']);
  });
  it('tells a ready Chromium from a missing one', () => {
    expect(browserPolicyState('Playwright Chromium is available.\nhelp').kind).toBe('ready');
    expect(
      browserPolicyState(
        'Chromium is missing; browser_open installs it automatically. Use /browser install…',
      ).kind,
    ).toBe('missing');
    expect(browserPolicyState('Browser setup failed: no disk').kind).toBe('other');
  });
});
