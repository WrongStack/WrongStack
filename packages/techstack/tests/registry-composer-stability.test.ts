import { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearRegistryCache, lookupRegistry } from '../src/registry/client.js';

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  get: vi.fn(),
}));

beforeEach(() => clearRegistryCache());
afterEach(() => {
  vi.mocked(httpsGet).mockReset();
  clearRegistryCache();
});

function serveVersions(versions: Array<Record<string, unknown>>): void {
  vi.mocked(httpsGet).mockImplementation((...args: unknown[]) => {
    const callback = args.find(
      (arg): arg is (response: IncomingMessage) => void => typeof arg === 'function',
    );
    if (!callback) throw new Error('Missing HTTPS response callback');
    const response = new IncomingMessage(new Socket());
    response.statusCode = 200;
    callback(response);
    queueMicrotask(() => {
      response.emit('data', JSON.stringify({ packages: { 'vendor/example': versions } }));
      response.emit('end');
    });
    const request = Object.create(ClientRequest.prototype) as ClientRequest;
    request.end = vi.fn();
    request.destroy = vi.fn(() => request);
    return request;
  });
}

it.each([
  'beta1',
  'BETA1',
  'Beta1',
  'ALPHA1',
  'Alpha1',
  'DEV',
  'dEv',
  'Rc1',
  'RC1',
  'rc1',
  'a',
  'a1',
  'a.1',
  'a-1',
  'A1',
  'b',
  'b1',
  'b.1',
  'b-1',
  'B1',
])('excludes the Composer preview label %s from latestStable', async (label) => {
  serveVersions([
    { version: `v2.0.0-${label}`, license: ['MIT'] },
    { version: 'v1.9.0' },
    { version: 'v1.10.0' },
  ]);
  const entry = await lookupRegistry('composer', 'vendor/example');
  expect(entry?.license).toBe('MIT');
  expect(entry?.latestStable).toBe('v1.10.0');
});

it('keeps stable version spelling and selects numerically rather than lexically', async () => {
  serveVersions([{ version: 'V1.9.0', license: ['MIT'] }, { version: 'V1.10.0' }]);
  expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBe('V1.10.0');
});

it.each(['ALPHA-build', 'BETA-build', 'DEV-build'])(
  'ignores build metadata %s when deciding stability',
  async (metadata) => {
    const version = `v2.0.0+${metadata}`;
    serveVersions([{ version, license: ['MIT'] }, { version: 'v1.10.0' }]);
    expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBe(version);
  },
);

it('reports no stable release for uppercase preview-only metadata', async () => {
  serveVersions([{ version: 'v2.0.0-BETA1', license: ['MIT'] }]);
  expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBeUndefined();
});

it.each(['a1', 'b1', '-a', '-b', '-A.1', '-B.1'])(
  'reports no stable release for abbreviated preview-only suffix %s',
  async (suffix) => {
    serveVersions([{ version: `v2.0.0${suffix}`, license: ['MIT'] }]);
    expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBeUndefined();
  },
);

it.each(['a1', 'b1'])(
  'keeps a stable release with alias-shaped build metadata %s',
  async (metadata) => {
    const version = `v2.0.0+${metadata}`;
    serveVersions([{ version, license: ['MIT'] }, { version: 'v1.10.0' }]);
    expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBe(version);
  },
);

it('handles an empty versions collection without fabricating a stable release', async () => {
  serveVersions([]);
  expect((await lookupRegistry('composer', 'vendor/example'))?.latestStable).toBeUndefined();
});
