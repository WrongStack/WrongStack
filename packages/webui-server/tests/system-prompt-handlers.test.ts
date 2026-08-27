/**
 * The identity-prompt picker surface.
 *
 * Two things here are easy to get wrong and expensive to notice:
 *  - `chosen` must come from the *raw* profile config file. The config loader
 *    materializes `systemPrompt: { variant: 'default' }` for every config, so
 *    reading it from the live Config would report "already chosen" on a fresh
 *    install and the browser would never open the first-run picker.
 *  - A variant change must rebuild the live prompt. Persisting alone leaves the
 *    running session on the old identity while the picker reports the new one.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handlePrefsUpdate,
  handleSystemPromptGet,
  type PrefsHandlerContext,
} from '../src/server/prefs-handlers.js';
import {
  buildSystemPromptInfo,
  unavailableSystemPromptInfo,
} from '../src/server/system-prompt-handlers.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sp-info-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const surface = (configPath: string, applyVariant = vi.fn()) => ({
  paths: () => ({}),
  profileConfigPath: configPath,
  current: () => 'default' as const,
  applyVariant,
});

function ctx(overrides: Partial<PrefsHandlerContext> = {}): PrefsHandlerContext {
  return {
    meta: {},
    snapshot: () => ({}),
    persist: async () => undefined,
    pendingConfirms: new Map(),
    send: vi.fn(),
    broadcast: vi.fn(),
    ...overrides,
  } as PrefsHandlerContext;
}

describe('buildSystemPromptInfo', () => {
  it('prices every bundled variant, cheapest first', async () => {
    const info = await buildSystemPromptInfo(surface(path.join(tmp, 'config.json')));

    expect(info.variants.map((v) => v.variant)).toEqual(['lite', 'default', 'pro']);
    for (const v of info.variants) expect(v.tokens).toBeGreaterThan(0);
    // The ladder only helps a user choose if the sizes actually differ.
    expect(info.variants[0]!.tokens).toBeLessThan(info.variants[1]!.tokens);
    expect(info.variants[1]!.tokens).toBeLessThan(info.variants[2]!.tokens);
  });

  it('reports chosen:false until the config file carries the key', async () => {
    const configPath = path.join(tmp, 'config.json');
    // A config that exists but has never been through the picker — the shape a
    // fresh install has, and the one that must still trigger the first-run ask.
    await fs.writeFile(configPath, JSON.stringify({ provider: 'openai' }), 'utf8');
    expect((await buildSystemPromptInfo(surface(configPath))).chosen).toBe(false);

    await fs.writeFile(configPath, JSON.stringify({ systemPrompt: { variant: 'pro' } }), 'utf8');
    expect((await buildSystemPromptInfo(surface(configPath))).chosen).toBe(true);
  });

  it('treats an unreadable config as "never chosen" rather than failing', async () => {
    const info = await buildSystemPromptInfo(surface(path.join(tmp, 'missing.json')));
    expect(info.chosen).toBe(false);
    expect(info.variants).toHaveLength(3);
  });
});

describe('handleSystemPromptGet', () => {
  it('answers with the catalogue when the host wired the picker', async () => {
    const send = vi.fn();
    await handleSystemPromptGet(
      ctx({ send, systemPrompt: surface(path.join(tmp, 'config.json')) }),
      {} as never,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![1] as { type: string; payload: { variants: unknown[] } };
    expect(msg.type).toBe('system_prompt.info');
    expect(msg.payload.variants).toHaveLength(3);
  });

  it('answers with the ASKING tab’s variant, not the host default', async () => {
    const send = vi.fn();
    await handleSystemPromptGet(
      ctx({
        send,
        systemPrompt: surface(path.join(tmp, 'config.json')),
        // Four tabs on one runtime each carry their own `systemPromptVariant`;
        // `surface.current()` only knows the host-wide default, so answering
        // from it told tab 3 it was running tab 1's identity prompt.
        metaFor: (id) => (id === 'tab-pro' ? { systemPromptVariant: 'pro' } : {}),
      }),
      {} as never,
      'tab-pro',
    );

    const msg = send.mock.calls[0]![1] as {
      payload: { current: string; sessionId?: string };
    };
    expect(msg.payload.current).toBe('pro');
    // Stamped, so the browser files it under the tab that asked instead of
    // over whichever one it is showing.
    expect(msg.payload.sessionId).toBe('tab-pro');
  });

  it('falls back to the host default for a tab that never chose', async () => {
    const send = vi.fn();
    await handleSystemPromptGet(
      ctx({
        send,
        systemPrompt: surface(path.join(tmp, 'config.json')),
        metaFor: () => ({}),
      }),
      {} as never,
      'tab-fresh',
    );

    const msg = send.mock.calls[0]![1] as { payload: { current: string } };
    expect(msg.payload.current).toBe('default');
  });

  it('answers explicitly when the host did not wire it', async () => {
    const send = vi.fn();
    await handleSystemPromptGet(ctx({ send }), {} as never);

    const msg = send.mock.calls[0]![1] as { payload: { variants: unknown[]; error?: string } };
    expect(msg.payload.variants).toHaveLength(0);
    expect(msg.payload.error).toBe(unavailableSystemPromptInfo().error);
  });
});

describe('prefs.update systemPromptVariant', () => {
  it('rebuilds the live prompt and republishes the catalogue', async () => {
    const applyVariant = vi.fn();
    const broadcast = vi.fn();
    const persist = vi.fn(async () => undefined);
    const context = ctx({
      broadcast,
      persist,
      systemPrompt: surface(path.join(tmp, 'config.json'), applyVariant),
    });

    await handlePrefsUpdate(context, {} as never, { systemPromptVariant: 'pro' });

    expect(persist).toHaveBeenCalledWith({ systemPromptVariant: 'pro' });
    // Second arg is the requesting session: per-tab prompt variants mean the
    // rebuild has to name which tab it is for (undefined = no tab stamped).
    expect(applyVariant).toHaveBeenCalledWith('pro', undefined);
    expect(broadcast.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain(
      'system_prompt.info',
    );
  });

  it('reports a failed rebuild instead of silently leaving the old prompt live', async () => {
    const send = vi.fn();
    const applyVariant = vi.fn(async () => {
      throw new Error('builder exploded');
    });
    const context = ctx({
      send,
      systemPrompt: surface(path.join(tmp, 'config.json'), applyVariant),
    });

    await handlePrefsUpdate(context, {} as never, { systemPromptVariant: 'lite' });

    const failure = send.mock.calls
      .map((c) => c[1] as { payload?: { success?: boolean; message?: string } })
      .find((m) => m.payload?.success === false);
    expect(failure?.payload?.message).toContain('builder exploded');
  });

  it('rejects a variant that is not on the menu', async () => {
    const send = vi.fn();
    const applyVariant = vi.fn();
    const context = ctx({
      send,
      systemPrompt: surface(path.join(tmp, 'config.json'), applyVariant),
    });

    await handlePrefsUpdate(context, {} as never, { systemPromptVariant: 'gigantic' });

    expect(applyVariant).not.toHaveBeenCalled();
    const msg = send.mock.calls[0]![1] as { payload: { success: boolean; message: string } };
    expect(msg.payload.success).toBe(false);
    expect(msg.payload.message).toContain('systemPromptVariant');
  });
});
