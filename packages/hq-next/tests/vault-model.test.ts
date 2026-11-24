import { describe, expect, it } from 'vitest';
import {
  auditActor,
  auditSentence,
  grantMatrix,
  secretFormError,
  vaultGate,
} from '../src/features/vault/model';
import type {
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultSecretMeta,
  VaultStatus,
} from '../src/hq/data/vault-api';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const base: VaultStatus = { state: 'unsealed', passwordConfigured: true, secureChannel: true };

const secret = (id: string, providerId: string, label: string): HqVaultSecretMeta => ({
  id,
  providerId,
  label,
  kind: 'api_key',
  version: 1,
  createdAt: '2026-11-24T09:00:00Z',
  updatedAt: '2026-11-24T09:00:00Z',
});

const device = (
  id: string,
  hostname: string,
  status: HqVaultDeviceRecord['status'],
): HqVaultDeviceRecord => ({
  id,
  hostname,
  status,
  encPublic: 'e',
  signPublic: 's',
  fingerprint: 'F',
  enrolledAt: '2026-11-24T09:00:00Z',
});

const grant = (id: string, secretId: string, deviceId: string): HqVaultGrantRecord => ({
  id,
  secretId,
  deviceId,
  policy: 'local',
  setActive: false,
  createdAt: '2026-11-24T09:00:00Z',
});

describe('vaultGate', () => {
  it('follows the server order: password, seal, channel, step-up', () => {
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
    expect(vaultGate({ ...base, elevatedUntil: new Date(NOW - 1).toISOString() }, NOW).kind).toBe(
      'locked',
    );
    const ready = vaultGate(
      { ...base, elevatedUntil: new Date(NOW + 4 * 60_000).toISOString() },
      NOW,
    );
    expect(ready).toMatchObject({ kind: 'ready', canWrite: true });
    expect(ready.detail).toContain('4 more minutes');
  });

  it('mentions the authenticator code only when 2FA is on', () => {
    expect(vaultGate({ ...base, totpEnabled: true }, NOW).detail).toContain('authenticator');
    expect(vaultGate(base, NOW).detail).not.toContain('authenticator');
  });
});

describe('grantMatrix', () => {
  it('drops revoked devices, puts approved ones first and fills the cells', () => {
    const secrets = [secret('s2', 'openai', 'b'), secret('s1', 'anthropic', 'a')];
    const devices = [
      device('d1', 'zeta', 'pending'),
      device('d2', 'alpha', 'approved'),
      device('d3', 'gone', 'revoked'),
    ];
    const { devices: cols, rows } = grantMatrix(secrets, devices, [grant('g1', 's2', 'd2')]);
    expect(cols.map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(rows.map((r) => r.secret.id)).toEqual(['s1', 's2']);
    expect(rows[1]!.cells.map((c) => c.grant?.id ?? null)).toEqual(['g1', null]);
  });
});

describe('audit wording', () => {
  const secrets = new Map([['s1', secret('s1', 'openai', 'team')]]);
  const devices = new Map([['d1', { ...device('d1', 'LAB-02', 'approved'), label: 'lab' }]]);

  it('names keys and devices and never needs a value', () => {
    expect(
      auditSentence(
        { at: 'x', kind: 'grant.create', actor: 'a', secretId: 's1', deviceId: 'd1' },
        secrets,
        devices,
      ),
    ).toBe('Gave team (openai) to lab');
    expect(
      auditSentence(
        { at: 'x', kind: 'fetch', actor: 'device:d1', deviceId: 'd1', secretIds: ['s1'] },
        secrets,
        devices,
      ),
    ).toBe('lab fetched 1 key');
    expect(
      auditSentence(
        { at: 'x', kind: 'secret.rotate', actor: 'a', secretId: 'zz', version: 3 },
        secrets,
        devices,
      ),
    ).toBe('Replaced a deleted key (version 3)');
    expect(auditActor('device:d1', devices)).toBe('lab');
    expect(auditActor('hq-dashboard:session', devices)).toBe('dashboard sign-in');
  });
});

describe('secretFormError', () => {
  it('checks provider id, name and key', () => {
    expect(secretFormError({ providerId: '../x', label: 'a', apiKey: 'k' })).toMatch(/Provider id/);
    expect(secretFormError({ providerId: 'openai', label: ' ', apiKey: 'k' })).toBe(
      'Name the key.',
    );
    expect(secretFormError({ providerId: 'openai', label: 'a', apiKey: '' })).toBe(
      'Paste the key.',
    );
    expect(secretFormError({ providerId: 'openai', label: 'a', apiKey: 'k' })).toBeNull();
  });
});
