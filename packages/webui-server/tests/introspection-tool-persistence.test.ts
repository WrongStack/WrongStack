import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { noOpVault } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleIntrospectionRoute,
  type IntrospectionRouteContext,
} from '../src/server/introspection-routes.js';
import { writeGlobalConfigFile } from '../src/server/pref-config-write.js';
import type { WSServerMessage } from '../src/server/types.js';

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tool-profile-persist-'));
  owned.push(dir);
  const file = join(dir, 'profiles/default/config.json');
  await mkdir(join(dir, 'profiles/default'), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      tools: { maxIterations: 73, disabledTools: ['keep-disabled'] },
      features: { memory: true },
      externalMarker: 'keep',
    }),
  );
  const store = new DefaultConfigStore({
    version: 1,
    tools: { maxIterations: 40, disabledTools: [] },
  } as unknown as Config);
  const tools = new ToolRegistry();
  for (const name of ['read', 'keep-disabled'])
    tools.register({
      name,
      description: name,
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: async () => '',
    } as Tool);
  tools.disable('keep-disabled');
  const sent: WSServerMessage[] = [];
  const ctx = {
    agent: { tools, ctx: {} } as never,
    configStore: store,
    getConfig: () => store.get() as unknown as Config,
    getProjectRoot: () => dir,
    getSessionId: () => 'fixture',
    getSessionStartedAt: () => 0,
    getModeId: () => 'default',
    send: (_ws: WebSocket, message: WSServerMessage) => sent.push(message),
    updateGlobalConfig: (mutate: (config: Record<string, unknown>) => void, label: string) =>
      writeGlobalConfigFile(file, noOpVault, mutate, label),
  } satisfies IntrospectionRouteContext;
  return { file, store, tools, ctx, sent };
}
describe('durable tool availability', () => {
  it('writes the active profile through the serialized writer and preserves fresh disk siblings', async () => {
    const { file, store, tools, ctx, sent } = await fixture();
    await handleIntrospectionRoute(ctx, {} as WebSocket, {
      type: 'tool.disable',
      payload: { name: 'read', requestId: 'durable-1' },
    });
    expect(tools.isDisabled('read')).toBe(true);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.tools.disabledTools).toEqual(['keep-disabled', 'read']);
    expect(saved.tools.maxIterations).toBe(73);
    expect(saved.features.memory).toBe(true);
    expect(saved.externalMarker).toBe('keep');
    expect(store.get().tools?.disabledTools).toEqual(['keep-disabled', 'read']);
    expect(sent.at(-1)?.payload).toMatchObject({ name: 'read', ok: true, requestId: 'durable-1' });
    await handleIntrospectionRoute(ctx, {} as WebSocket, {
      type: 'tool.enable',
      payload: { name: 'read', requestId: 'durable-2' },
    });
    expect(JSON.parse(await readFile(file, 'utf8')).tools.disabledTools).toEqual(['keep-disabled']);
    expect(tools.isDisabled('read')).toBe(false);
  });
  it('rolls back registry state and refuses success when the profile write fails', async () => {
    const { ctx, store, tools, sent, file } = await fixture();
    const blocked = {
      ...ctx,
      updateGlobalConfig: async () => {
        throw Error('fixture profile write refused');
      },
    };
    await handleIntrospectionRoute(blocked, {} as WebSocket, {
      type: 'tool.disable',
      payload: { name: 'read', requestId: 'durable-error' },
    });
    expect(sent.at(-1)?.payload).toMatchObject({
      name: 'read',
      ok: false,
      requestId: 'durable-error',
      error: 'fixture profile write refused',
    });
    expect(tools.isDisabled('read')).toBe(false);
    expect(store.get().tools?.disabledTools).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8')).tools.disabledTools).toEqual(['keep-disabled']);
  });
});
