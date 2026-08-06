import { describe, expect, it } from 'vitest';
import {
  hasProviderCredential,
  hasProviderKeyInConfig,
  hasProviderKeyInEnv,
} from '../../src/models/provider-credentials.js';

/**
 * Three surfaces answered "does this provider have a key?" and none of them
 * agreed:
 *
 *  - the CLI picker (`provider-helpers.hasApiKey`) — env OR config, complete;
 *  - `/modelcaps` — config only, so the `●`/`○` marker was hollow for every
 *    provider keyed through an environment variable, which is how most
 *    providers are keyed;
 *  - the WebUI provider list — `savedIds.has(id) || env`, where `savedIds`
 *    means "appears in the saved config at all", so a provider saved with a
 *    `baseUrl` and no key reported ready-to-use.
 *
 * The rule is four lines. That it lived in three places is the defect, and
 * these are the cases that told them apart.
 */
describe('provider credential detection', () => {
  const anthropic = { id: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] };

  it('finds a key in the environment — the case /modelcaps missed', () => {
    expect(hasProviderCredential(anthropic, undefined, { ANTHROPIC_API_KEY: 'sk-x' })).toBe(true);
    expect(hasProviderKeyInEnv(anthropic, { ANTHROPIC_API_KEY: 'sk-x' })).toBe(true);
  });

  it('finds a key stored in the saved config', () => {
    const config = { providers: { anthropic: { apiKey: 'sk-stored' } } };
    expect(hasProviderCredential(anthropic, config, {})).toBe(true);
  });

  it('finds a key in a rotation entry', () => {
    const config = { providers: { anthropic: { apiKeys: [{}, { apiKey: 'sk-second' }] } } };
    expect(hasProviderCredential(anthropic, config, {})).toBe(true);
  });

  it('a saved provider with no key is NOT keyed — the case the WebUI got wrong', () => {
    // `savedIds.has('anthropic')` was true here, and the panel said ready.
    const config = { providers: { anthropic: {} } };
    expect(hasProviderCredential(anthropic, config, {})).toBe(false);
    expect(hasProviderKeyInConfig('anthropic', config)).toBe(false);
  });

  it('treats an empty-string key as absent', () => {
    expect(hasProviderCredential(anthropic, { providers: { anthropic: { apiKey: '' } } }, {})).toBe(
      false,
    );
  });

  it('an empty rotation array is not a key', () => {
    expect(
      hasProviderCredential(anthropic, { providers: { anthropic: { apiKeys: [] } } }, {}),
    ).toBe(false);
  });

  it('an empty env var value does not count', () => {
    expect(hasProviderCredential(anthropic, undefined, { ANTHROPIC_API_KEY: '' })).toBe(false);
  });

  it('a provider declaring no env vars falls back to the config alone', () => {
    const local = { id: 'omniroute' };
    expect(hasProviderCredential(local, undefined, { ANTHROPIC_API_KEY: 'sk-x' })).toBe(false);
    expect(hasProviderCredential(local, { providers: { omniroute: { apiKey: 'k' } } }, {})).toBe(
      true,
    );
  });

  it('says nothing about keyless local gateways', () => {
    // A loopback server needing no credential is a DIFFERENT question
    // (`isKeylessLocalProvider`). Folding it in here would make "has a key"
    // mean "is usable" and lose the distinction the picker needs.
    const ollama = { id: 'ollama', envVars: [] };
    expect(hasProviderCredential(ollama, undefined, {})).toBe(false);
  });
});
