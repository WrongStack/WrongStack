import { describe, expect, it } from 'vitest';
import { providerBrand } from '../src/features/vault/brand';
import {
  auditActor,
  auditSentence,
  baseUrlError,
  catalogGroups,
  configuredCounts,
  keyFormError,
  maskedKey,
  nextProfileId,
  parseModelList,
  profileIdError,
  vaultGate,
} from '../src/features/vault/model';
import type {
  HqVaultDeviceRecord,
  HqVaultProfileMeta,
  VaultCatalogProvider,
  VaultStatus,
} from '../src/hq/data/vault-api';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const base: VaultStatus = { state: 'unsealed', passwordConfigured: true, secureChannel: true };

const profile = (id: string, type = id): HqVaultProfileMeta => ({
  id,
  type,
  version: 1,
  createdAt: '2026-11-24T09:00:00Z',
  updatedAt: '2026-11-24T09:00:00Z',
  keys: [],
  deviceIds: [],
});

const provider = (id: string, family: string, name = id): VaultCatalogProvider => ({
  id,
  name,
  family,
  envVars: [],
  models: [],
});

const device = (id: string, hostname: string): HqVaultDeviceRecord => ({
  id,
  hostname,
  status: 'approved',
  encPublic: 'e',
  signPublic: 's',
  fingerprint: 'F',
  enrolledAt: '2026-11-24T09:00:00Z',
});

describe('vaultGate', () => {
  it('checks in the server order: password, seal, channel, unlock', () => {
    expect(vaultGate({ ...base, state: 'unavailable', passwordConfigured: false }, NOW).kind).toBe(
      'unavailable',
    );
    expect(vaultGate({ ...base, state: 'sealed', secureChannel: false }, NOW).kind).toBe('sealed');
    expect(vaultGate({ ...base, secureChannel: false }, NOW)).toMatchObject({
      kind: 'insecure',
      canRead: true,
      canWrite: false,
    });
    expect(vaultGate(base, NOW).kind).toBe('locked');
    const ready = vaultGate(
      { ...base, elevatedUntil: new Date(NOW + 4 * 60_000 + 1).toISOString() },
      NOW,
    );
    expect(ready).toMatchObject({ kind: 'ready', canWrite: true, detail: '5 more minutes' });
    expect(vaultGate({ ...base, elevatedUntil: new Date(NOW - 1).toISOString() }, NOW).kind).toBe(
      'locked',
    );
  });
});

describe('catalog', () => {
  const catalog = [
    provider('groq', 'openai-compatible', 'Groq'),
    provider('anthropic', 'anthropic', 'Anthropic'),
    provider('openai', 'openai', 'OpenAI'),
    provider('mystery', 'something-new', 'Mystery'),
  ];

  it('puts popular providers first in a fixed order, then the rest by family', () => {
    const groups = catalogGroups(
      [...catalog, provider('fireworks-like', 'openai-compatible', 'Fireworks-like')],
      '',
    );
    expect(groups.map((g) => [g.title, g.providers.map((p) => p.id)])).toEqual([
      ['Popular', ['anthropic', 'openai', 'groq']],
      ['OpenAI-compatible', ['fireworks-like']],
      ['Other', ['mystery']],
    ]);
  });

  it('searches name, id and family into one Matches group', () => {
    expect(catalogGroups(catalog, 'GRO')).toEqual([{ title: 'Matches', providers: [catalog[0]] }]);
    expect(catalogGroups(catalog, 'zzz')).toEqual([]);
  });

  it('gives a new profile the provider id, then id-2, id-3', () => {
    expect(nextProfileId('openai', [])).toBe('openai');
    expect(nextProfileId('openai', [profile('openai'), profile('openai-2')])).toBe('openai-3');
    expect(configuredCounts([profile('openai'), profile('work', 'openai')]).get('openai')).toBe(2);
  });
});

describe('forms', () => {
  it('checks the alias against the server rule and existing profiles', () => {
    expect(profileIdError('../x', [])).toMatch(/letters, digits/);
    expect(profileIdError('openai', [profile('openai')])).toMatch(/already saved/);
    expect(profileIdError('team-proxy', [profile('openai')])).toBeNull();
  });

  it('checks keys and endpoints', () => {
    expect(keyFormError({ label: '', apiKey: 'k' })).toBe('Name the key.');
    expect(keyFormError({ label: 'team', apiKey: ' ' })).toBe('Paste the key.');
    expect(keyFormError({ label: 'team', apiKey: 'k' })).toBeNull();
    expect(baseUrlError('', true)).toMatch(/needs its endpoint/);
    expect(baseUrlError('', false)).toBeNull();
    expect(baseUrlError('file:///etc/passwd', false)).toMatch(/http\(s\)/);
    expect(baseUrlError('https://llm.example.com/v1', true)).toBeNull();
  });

  it('parses a model list and masks a key by its hint', () => {
    expect(parseModelList('a, b\nb ,, c')).toEqual(['a', 'b', 'c']);
    expect(parseModelList(' , ')).toBeUndefined();
    expect(maskedKey('f3a9')).toBe('••••f3a9');
    expect(maskedKey('')).toBe('••••');
  });
});

describe('providerBrand', () => {
  it('prefers the endpoint domain, then the id or its alias, and never guesses', () => {
    expect(providerBrand('team-proxy', { baseUrl: 'https://openrouter.ai/api/v1' })?.name).toBe(
      'OpenRouter',
    );
    expect(providerBrand('openai-2')?.name).toBe('OpenAI');
    expect(providerBrand('openai-hq')?.name).toBe('OpenAI');
    expect(providerBrand('work', { type: 'anthropic' })?.name).toBe('Anthropic');
    expect(providerBrand('team-proxy', { baseUrl: 'https://llm.internal/v1' })).toBeNull();
  });
});

describe('audit in words', () => {
  const devices = new Map([['d1', device('d1', 'LAB-02')]]);
  it('names profiles, keys and devices without a value', () => {
    const at = '2026-11-24T09:59:00Z';
    expect(
      auditSentence(
        { at, kind: 'key.set', actor: 'x', profileId: 'openai', keyLabel: 'team', version: 1 },
        devices,
      ),
    ).toBe('Saved openai/team');
    expect(
      auditSentence(
        { at, kind: 'key.set', actor: 'x', profileId: 'openai', keyLabel: 'team', version: 3 },
        devices,
      ),
    ).toBe('Replaced openai/team (version 3)');
    expect(
      auditSentence(
        { at, kind: 'grant.create', actor: 'x', profileId: 'openai', deviceId: 'd1' },
        devices,
      ),
    ).toBe('Gave openai to LAB-02');
    expect(
      auditSentence(
        { at, kind: 'fetch', actor: 'device:d1', deviceId: 'd1', profileIds: ['a', 'b'] },
        devices,
      ),
    ).toBe('LAB-02 fetched 2 providers');
    expect(auditActor('device:d1', devices)).toBe('LAB-02');
    expect(auditActor('hq-dashboard:session', devices)).toBe('dashboard sign-in');
  });
});
