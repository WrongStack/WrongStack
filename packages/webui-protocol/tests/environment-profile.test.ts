import { describe, expect, it } from 'vitest';
import { createAutomationJobInput, editableAutomationJob } from '../src/automation.js';
import { exportAutomationJob, importAutomationJob } from '../src/automation-portability.js';
import {
  canonicalEnvironmentProfile,
  type EnvironmentProfile,
  exportEnvironmentProfile,
  parseEnvironmentProfile,
  validateEnvironmentProfile,
} from '../src/environment-profile.js';

const profile = (): EnvironmentProfile => ({
  version: 1,
  name: 'bun-project',
  image: 'trusted:1',
  setupCommands: [['bun', 'install', '--frozen-lockfile']],
  setupTimeoutMs: 30_000,
  services: [
    {
      name: 'db',
      image: 'postgres:17',
      command: [],
      healthCommand: ['pg_isready'],
      envNames: ['POSTGRES_PASSWORD'],
    },
  ],
  caches: [{ name: 'bun', target: '/home/node/.bun/install/cache' }],
  ports: [{ name: 'preview', port: 3000, protocol: 'http' }],
});
describe('portable environment profiles', () => {
  it('round-trips reusable settings, BOM documents and immutable editable jobs', () => {
    const input = profile();
    expect(parseEnvironmentProfile(`\uFEFF${exportEnvironmentProfile(input)}`)).toEqual(input);
    const job = { ...createAutomationJobInput(), environment: input };
    const editable = editableAutomationJob(job);
    editable.environment!.setupCommands[0]!.push('changed');
    expect(input.setupCommands[0]).not.toContain('changed');
    expect(importAutomationJob(exportAutomationJob(job))).toMatchObject({
      enabled: false,
      yolo: false,
      environment: input,
    });
  });
  it('fingerprints object fields consistently while preserving command order', () => {
    const input = profile();
    expect(canonicalEnvironmentProfile({ ...input, name: input.name })).toBe(
      canonicalEnvironmentProfile(input),
    );
    expect(
      canonicalEnvironmentProfile(
        Object.fromEntries(Object.entries(input).reverse()) as unknown as EnvironmentProfile,
      ),
    ).toBe(canonicalEnvironmentProfile(input));
    expect(
      canonicalEnvironmentProfile({
        ...input,
        setupCommands: [...input.setupCommands, ['echo', 'second']],
      }),
    ).not.toBe(canonicalEnvironmentProfile(input));
  });
  it.each([
    { version: 2 },
    { setupCommands: Array.from({ length: 9 }, () => ['echo', 'setup']) },
    { services: Array.from({ length: 5 }, () => profile().services[0]) },
    { services: [{ ...profile().services[0], envNames: ['TOKEN', 'TOKEN'] }] },
    { mounts: ['/home:/host'] },
    { network: 'host' },
    { image: '--privileged' },
    { services: [{ ...profile().services[0], env: { TOKEN: 'secret' } }] },
    { services: [{ ...profile().services[0], healthCommand: [] }] },
    { caches: [{ name: 'vault', target: '/home/node/.wrongstack' }] },
    { caches: [{ name: 'source', target: '/workspace' }] },
    { caches: [{ name: 'escape', target: '/home/node/.cache/../.wrongstack' }] },
    { ports: [{ name: 'public', port: 80, protocol: 'http' }] },
    { ports: [{ name: 'preview', port: 3000, protocol: 'http', host: '0.0.0.0' }] },
    { setupCommands: [['echo', 'invalid\nargument']] },
    { setupTimeoutMs: 0 },
  ])('refuses unsupported runtime options and malformed profiles: %j', (patch) => {
    expect(() => validateEnvironmentProfile({ ...profile(), ...patch })).toThrow();
  });
  it('bounds document size and rejects duplicate services, caches and ports', () => {
    expect(() => parseEnvironmentProfile(' '.repeat(65_537))).toThrow('64 KiB');
    for (const field of ['services', 'caches', 'ports'] as const) {
      const input = profile();
      (input[field] as unknown[]).push(input[field][0]);
      expect(() => validateEnvironmentProfile(input)).toThrow();
    }
  });
  it('rejects profiles whose valid argv expands beyond the portable document bound', () => {
    expect(() =>
      exportEnvironmentProfile({
        ...profile(),
        setupCommands: Array.from({ length: 8 }, () => ['echo', 'x'.repeat(8192)]),
      }),
    ).toThrow('64 KiB');
  });
  it.each([
    { type: 'other', version: 1 },
    { type: 'wrongstack.environment', version: 2 },
  ])('rejects an unsupported document envelope: %j', (wrapper) => {
    expect(() =>
      parseEnvironmentProfile(JSON.stringify({ ...wrapper, profile: profile() })),
    ).toThrow('Unsupported environment profile document');
  });
  it('throws a domain Error instead of raw SyntaxError on malformed JSON', () => {
    expect(() => parseEnvironmentProfile('{invalid json')).toThrow(
      'Invalid environment profile JSON',
    );
  });
});
