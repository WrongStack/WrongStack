/**
 * "Import from HQ" over the WebUI protocol (WebUI, VibeUI and Desktop share
 * it): enroll, import, keep HQ's marker through a local edit, sync. The HQ key
 * vault is a real in-process store reached through a fetch bridge, the device
 * client is the real one, and so are the route dispatch and the projection.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderConfig, SecretVault } from '@wrongstack/contracts/types';
import {
  formatHqVaultEnrollmentToken,
  HqCredentialService,
  type HqVaultEnrollRequest,
  type HqVaultFetchRequest,
  HqVaultStore,
} from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { projectSavedProviders } from '../src/server/provider/projection.js';
import { createProviderOperations } from '../src/server/provider-handlers.js';
import { handleProviderRoute } from '../src/server/provider-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

/** A stand-in for the local SecretVault: reversible, so device keys round-trip. */
const vault = {
  encrypt: (value: string) => `enc:v1:${Buffer.from(value).toString('base64')}`,
  decrypt: (value: string) => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString(),
} as unknown as SecretVault;

let root: string;
let hqStore: HqVaultStore;
let providers: Record<string, ProviderConfig>;
let sent: WSServerMessage[];
let broadcasts: WSServerMessage[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-hq-import-'));
  hqStore = await HqVaultStore.open(path.join(root, '.wrongstack', 'hq'), undefined);
  providers = {};
  sent = [];
  broadcasts = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** HQ's two device routes, answered in process. */
const hqFetch = (async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const answer = url.endsWith('/api/vault/enroll')
    ? await hqStore.enroll(body as HqVaultEnrollRequest)
    : await hqStore.fetch(body as HqVaultFetchRequest);
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;

function operations(
  deliver: (ws: WebSocket, message: WSServerMessage) => void = (_ws, message) => sent.push(message),
) {
  const store = {
    load: async () => structuredClone(providers),
    save: async (next: Record<string, ProviderConfig>) => {
      providers = structuredClone(next);
    },
  };
  return createProviderOperations({
    providerStore: store,
    broadcast: (message) => broadcasts.push(message),
    send: deliver,
    hqCredentials: new HqCredentialService({
      globalRoot: path.join(root, 'device'),
      vault,
      fetchImpl: hqFetch,
      mutateProviders: async (mutator) => {
        const next = structuredClone(providers);
        await mutator(next);
        providers = next;
      },
    }),
  });
}

function socket(remoteAddress: string): WebSocket {
  return { _socket: { remoteAddress }, readyState: 1 } as unknown as WebSocket;
}

async function route(ws: WebSocket, type: string, payload: unknown = {}) {
  const handlers = operations();
  await handleProviderRoute(ws, { type, payload }, { providerHandlers: handlers } as never);
  return sent.at(-1)?.payload as Record<string, unknown>;
}

async function token(): Promise<string> {
  const minted = await hqStore.mintEnrollmentCode({}, 'admin');
  return formatHqVaultEnrollmentToken(minted.codeId, minted.code);
}

describe('Import from HQ over the WebUI protocol', () => {
  it('enrolls from this machine, imports, marks HQ providers, and keeps the mark through a local edit', async () => {
    const local = socket('127.0.0.1');
    expect(await route(local, 'hq.status')).toMatchObject({ available: true, enrolled: false });

    await hqStore.createProfile(
      {
        id: 'team-proxy',
        family: 'openai-compatible',
        baseUrl: 'https://llm.internal.example/v1',
        apiKey: 'sk-team-0001',
        keyLabel: 'team',
      },
      'admin',
    );
    const enrolled = await route(local, 'hq.enroll', {
      hqUrl: 'http://127.0.0.1:1',
      token: await token(),
    });
    expect(enrolled).toMatchObject({ enrolled: true, granted: [] });
    const [device] = hqStore.listDevices();
    await hqStore.setGrant('team-proxy', device!.id, true, 'admin');

    const imported = await route(local, 'hq.import');
    expect(imported.report).toEqual(['Added team-proxy']);
    expect(broadcasts.at(-1)?.type).toBe('providers.saved');
    const [view] = projectSavedProviders(providers);
    expect(view).toMatchObject({
      id: 'team-proxy',
      hq: { profileId: 'team-proxy' },
      apiKeys: [expect.objectContaining({ label: 'team', fromHq: true })],
    });
    expect(JSON.stringify(view)).not.toContain('sk-team-0001');

    // A local edit through the provider handlers keeps HQ's mark…
    await route(local, 'provider.update', { id: 'team-proxy', models: ['gpt-team'] });
    expect(providers['team-proxy']?.source).toMatchObject({ kind: 'hq', profileId: 'team-proxy' });
    // …so the next sync finds the same entry instead of adding team-proxy-hq.
    const synced = await route(local, 'hq.sync');
    expect(Object.keys(providers)).toEqual(['team-proxy']);
    expect(synced.report).toEqual(['Updated team-proxy (changed in HQ)']);

    const gone = await route(local, 'hq.unenroll', { removeKeys: true });
    expect(gone).toMatchObject({ enrolled: false, report: ['Removed team-proxy'] });
    expect(providers).toEqual({});
  });

  it('answers a correlated request (Desktop) on its requestId, still as a loopback peer', async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const local = {
      _socket: { remoteAddress: '127.0.0.1' },
      readyState: 1,
      send: (raw: string) => frames.push(JSON.parse(raw)),
    } as unknown as WebSocket;
    const handlers = operations((ws, message) => ws.send(JSON.stringify(message)));
    const ask = async (type: string, payload: Record<string, unknown>) => {
      await handleProviderRoute(local, { type, payload }, { providerHandlers: handlers } as never);
      return frames.at(-1);
    };

    await hqStore.createProfile(
      {
        id: 'team',
        family: 'openai-compatible',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'sk-1',
      },
      'admin',
    );
    const enrolled = await ask('hq.enroll', {
      hqUrl: 'http://127.0.0.1:1',
      token: await token(),
      requestId: 'r1',
    });
    expect(enrolled).toMatchObject({
      type: 'hq.state',
      payload: { enrolled: true, requestId: 'r1' },
    });
    expect(enrolled?.payload.error).toBeUndefined();
    await hqStore.setGrant('team', hqStore.listDevices()[0]!.id, true, 'admin');

    const imported = await ask('hq.import', { requestId: 'r2' });
    expect(imported).toMatchObject({
      type: 'hq.state',
      payload: { report: ['Added team'], requestId: 'r2' },
    });
  });

  it('refuses to enroll a peer on another machine over plain HTTP', async () => {
    const remote = socket('192.168.1.20');
    const answer = await route(remote, 'hq.enroll', {
      hqUrl: 'http://127.0.0.1:1',
      token: await token(),
    });
    expect(answer).toMatchObject({ enrolled: false });
    expect(String(answer.error)).toMatch(/must not cross the network/);
    expect(hqStore.listDevices()).toEqual([]);
  });

  it('a host without an HQ client says so', async () => {
    const handlers = createProviderOperations({
      providerStore: { load: async () => ({}), save: async () => undefined },
      broadcast: () => undefined,
      send: (_ws, message) => sent.push(message),
    });
    await handleProviderRoute(socket('127.0.0.1'), { type: 'hq.status', payload: {} }, {
      providerHandlers: handlers,
    } as never);
    expect(sent.at(-1)).toEqual({
      type: 'hq.state',
      payload: { available: false, enrolled: false },
    });
  });
});
