import { describe, expect, it } from 'vitest';
import { codingConnections } from '../src/data/coding-plans';
import { curatedProviders } from '../src/data/providers';

/**
 * Affiliate/referral links were removed from the website on purpose. These
 * guards fail if one is reintroduced in the data that every plan and provider
 * surface renders from.
 */
const AFFILIATE_PARAM = /([?&](ref|ic|aff|code|source|via|invite)=)/i;

describe('coding plans — no affiliate links', () => {
  it.each(codingConnections.map((connection) => [connection.id, connection] as const))(
    '%s carries no affiliate URL or referral parameters',
    (_id, connection) => {
      expect(connection).not.toHaveProperty('affiliateUrl');
      expect(connection.subscribeUrl).not.toMatch(AFFILIATE_PARAM);
      expect(connection.docsUrl).not.toMatch(AFFILIATE_PARAM);
    },
  );

  it('keeps every provider signup link on the official subscribe URL', () => {
    const subscribeById = new Map(codingConnections.map((c) => [c.id, c.subscribeUrl]));
    const checked = curatedProviders.filter((provider) => provider.signupUrl);
    expect(checked.length).toBeGreaterThan(0);
    for (const provider of checked) {
      expect(provider.signupUrl).not.toMatch(AFFILIATE_PARAM);
      const official = [...subscribeById.values()];
      expect(official).toContain(provider.signupUrl);
    }
  });
});
