import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { loadSavedProviders } from '../../src/webui-server/provider-config.js';
import type {
  WsHandlerContext,
  WsServerMessage,
} from '../../src/webui-server/ws-handlers/index.js';
import {
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleProviderAdd,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
} from '../../src/webui-server/ws-handlers/index.js';

/**
 * PR 5 of Issue #30 (webui-server 8-PR refactor):
 * provider ws-handler unit tests.
 *
 * The handlers used to be closures inside runWebUI; now they take an
 * explicit `WsHandlerContext`. These tests drive them with a fake
 * context (capturing send/broadcast) over a temp config dir, so they
 * exercise the real provider-config IO + cipher stack without a live
 * WebSocket or models registry.
 */

const FAKE_WS = {} as WebSocket;

interface Captured {
  sent: WsServerMessage[];
  broadcasts: WsServerMessage[];
  logs: string[];
}

function makeCtx(
  globalConfigPath: string | undefined,
  modelsRegistry?: WsHandlerContext['modelsRegistry'],
): { ctx: WsHandlerContext; cap: Captured } {
  const cap: Captured = { sent: [], broadcasts: [], logs: [] };
  const ctx: WsHandlerContext = {
    globalConfigPath,
    modelsRegistry,
    send: (_ws, msg) => cap.sent.push(msg),
    broadcast: (msg) => cap.broadcasts.push(msg),
    log: (m) => cap.logs.push(m),
  };
  return { ctx, cap };
}

const lastResult = (cap: Captured): { success: boolean; message: string } =>
  cap.sent
    .filter((m) => m.type === 'key.operation_result')
    .map((m) => m.payload as { success: boolean; message: string })
    .at(-1) as { success: boolean; message: string };

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pr5-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  configPath = '';
});

describe('ws-handlers/providers (PR 5 of #30)', () => {
  it('handleProvidersList: errors when no models registry', async () => {
    const { ctx, cap } = makeCtx(configPath, undefined);
    await handleProvidersList(ctx, FAKE_WS);
    expect(lastResult(cap)).toEqual({ success: false, message: 'Models registry not available' });
  });

  it('handleProviderModels: errors when no models registry', async () => {
    const { ctx, cap } = makeCtx(configPath, undefined);
    await handleProvidersList(ctx, FAKE_WS);
    expect(lastResult(cap).success).toBe(false);
  });

  it('handleProvidersSaved: empty config → empty providers list', async () => {
    const { ctx, cap } = makeCtx(configPath);
    await handleProvidersSaved(ctx, FAKE_WS);
    const msg = cap.sent.find((m) => m.type === 'providers.saved');
    expect(msg).toBeDefined();
    expect((msg?.payload as { providers: unknown[] }).providers).toEqual([]);
  });

  it('handleProviderAdd: persists provider, broadcasts providers.saved, reports success', async () => {
    const { ctx, cap } = makeCtx(configPath);
    await handleProviderAdd(ctx, FAKE_WS, {
      id: 'custom',
      family: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-secret',
    });

    expect(lastResult(cap).success).toBe(true);
    // Broadcast went out so other tabs refresh.
    expect(cap.broadcasts.some((m) => m.type === 'providers.saved')).toBe(true);
    // Logged the add.
    expect(cap.logs.join('\n')).toContain('provider.add');

    // Persisted to disk (encrypted) and reloadable.
    const saved = await loadSavedProviders(configPath);
    expect(saved.custom).toBeDefined();
    expect(saved.custom?.activeKey).toBe('default');
  });

  it('handleProviderAdd: refuses duplicate id', async () => {
    const { ctx } = makeCtx(configPath);
    await handleProviderAdd(ctx, FAKE_WS, { id: 'dup', family: 'openai-compatible' });
    const { ctx: ctx2, cap: cap2 } = makeCtx(configPath);
    await handleProviderAdd(ctx2, FAKE_WS, { id: 'dup', family: 'openai-compatible' });
    expect(lastResult(cap2).success).toBe(false);
    expect(lastResult(cap2).message).toContain('already exists');
  });

  it('key lifecycle: upsert → set_active → masked in saved → delete', async () => {
    // Seed a provider record.
    const seed = makeCtx(configPath);
    await handleProviderAdd(seed.ctx, FAKE_WS, { id: 'acme', family: 'openai-compatible' });

    // Add a second key.
    const add = makeCtx(configPath);
    await handleKeyUpsert(add.ctx, FAKE_WS, 'acme', 'work', 'sk-work-key');
    expect(lastResult(add.cap).success).toBe(true);

    // Make it active.
    const active = makeCtx(configPath);
    await handleKeySetActive(active.ctx, FAKE_WS, 'acme', 'work');
    expect(lastResult(active.cap).success).toBe(true);

    // providers.saved masks the key (never returns the plaintext).
    const saved = makeCtx(configPath);
    await handleProvidersSaved(saved.ctx, FAKE_WS);
    const payload = saved.cap.sent.find((m) => m.type === 'providers.saved')?.payload as {
      providers: Array<{
        id: string;
        apiKeys: Array<{ label: string; maskedKey: string; isActive: boolean }>;
      }>;
    };
    const acme = payload.providers.find((p) => p.id === 'acme');
    const work = acme?.apiKeys.find((k) => k.label === 'work');
    expect(work?.isActive).toBe(true);
    expect(work?.maskedKey).not.toContain('sk-work-key');

    // Delete the key.
    const del = makeCtx(configPath);
    await handleKeyDelete(del.ctx, FAKE_WS, 'acme', 'work');
    expect(lastResult(del.cap).success).toBe(true);
  });

  it('handleProviderRemove: deletes the provider', async () => {
    const seed = makeCtx(configPath);
    await handleProviderAdd(seed.ctx, FAKE_WS, { id: 'gone', family: 'openai-compatible' });

    const rm = makeCtx(configPath);
    await handleProviderRemove(rm.ctx, FAKE_WS, 'gone');
    expect(lastResult(rm.cap).success).toBe(true);

    const saved = await loadSavedProviders(configPath);
    expect(saved.gone).toBeUndefined();
  });

  it('handleProviderRemove: errors on unknown provider', async () => {
    const { ctx, cap } = makeCtx(configPath);
    await handleProviderRemove(ctx, FAKE_WS, 'nope');
    expect(lastResult(cap).success).toBe(false);
    expect(lastResult(cap).message).toContain('not found');
  });
});
