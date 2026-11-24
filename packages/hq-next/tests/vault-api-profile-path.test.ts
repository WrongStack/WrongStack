/**
 * The dashboard addresses a provider profile by id in a path segment, and HQ
 * matches that segment literally against its own id grammar
 * (`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`, `packages/hq/src/vault/store-profiles.ts`).
 * A legal id therefore has to travel verbatim: `:` belongs to the grammar (the
 * alias field advertises it) and `%3A` matches no route. Anything outside the
 * grammar is still percent-encoded.
 */
import { afterEach, expect, it } from 'vitest';
import { deleteVaultProfile, updateVaultProfile } from '../src/hq/data/vault-api.js';

const realFetch = globalThis.fetch;
const requests: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ profile: { id: 'team:proxy' }, deleted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  requests.length = 0;
});

it('sends a legal colon alias verbatim, because the route matches the id literally', async () => {
  stubFetch();
  await updateVaultProfile('team:proxy', { models: null });
  await deleteVaultProfile('team:proxy');
  expect(requests).toEqual(['/api/vault/profiles/team:proxy', '/api/vault/profiles/team:proxy']);
});

it('still percent-encodes a character the id grammar does not allow', async () => {
  stubFetch();
  await deleteVaultProfile('team proxy');
  expect(requests).toEqual(['/api/vault/profiles/team%20proxy']);
});
