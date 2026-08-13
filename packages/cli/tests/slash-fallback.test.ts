import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import { buildFallbackCommand } from '../src/slash-commands/fallback.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeCtx(initial: Record<string, unknown> = {}) {
  const wsDir = mkdtempSync(path.join(tmpdir(), 'wstack-fallback-'));
  const globalConfig = path.join(wsDir, 'config.json');
  const profileConfig = path.join(wsDir, 'profiles', 'default', 'config.json');
  const seed = { provider: 'anthropic', model: 'opus', providers: {}, ...initial };
  writeFileSync(globalConfig, JSON.stringify({ version: 1, activeProfile: 'default' }, null, 2));
  mkdirSync(path.dirname(profileConfig), { recursive: true });
  writeFileSync(profileConfig, JSON.stringify(seed, null, 2));
  let live: Record<string, unknown> = { ...seed };
  const update = vi.fn((patch: Record<string, unknown>) => {
    live = { ...live, ...patch };
  });
  const ctx = {
    configStore: { get: vi.fn(() => live), update },
    paths: { globalConfig, profileConfig: () => profileConfig },
  } as never as SlashCommandContext;
  const readFile = () => JSON.parse(readFileSync(profileConfig, 'utf8')) as Record<string, unknown>;
  return { ctx, update, readFile, getLive: () => live };
}

describe('/fallback', () => {
  it('shows the current chain and auto state with no args', async () => {
    const { ctx } = makeCtx({ fallbackModels: ['openai/gpt-4o'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('');
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('Fallback chain');
    expect(msg).toContain('openai/gpt-4o');
    expect(msg).toContain('auto');
  });

  it('sets and clears a fully-qualified continuity bridge', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);

    const set = await cmd.run('bridge set openai/gpt-4o');
    expect(stripAnsi(set?.message ?? '')).toContain('continuity bridge');
    expect(readFile().fallbackBridge).toBe('openai/gpt-4o');
    expect(update).toHaveBeenCalledWith({ fallbackBridge: 'openai/gpt-4o' });

    const clear = await cmd.run('bridge clear');
    expect(stripAnsi(clear?.message ?? '')).toContain('disabled');
    expect(readFile()).not.toHaveProperty('fallbackBridge');
    expect(update).toHaveBeenCalledWith({ fallbackBridge: '' });
  });

  it('rejects a bare-model continuity bridge', async () => {
    const { ctx, readFile } = makeCtx();
    const res = await buildFallbackCommand(ctx).run('bridge set gpt-4o');
    expect(stripAnsi(res?.message ?? '')).toContain('Usage:');
    expect(readFile()).not.toHaveProperty('fallbackBridge');
  });

  it('add appends a model to the explicit chain and persists', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('add openai/gpt-4o');
    expect(stripAnsi(res?.message ?? '')).toContain('added');
    expect(readFile().fallbackModels).toEqual(['openai/gpt-4o']);
    expect(update).toHaveBeenCalledWith({ fallbackModels: ['openai/gpt-4o'] });
  });

  it('add rejects a duplicate', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['openai/gpt-4o'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('add openai/gpt-4o');
    expect(stripAnsi(res?.message ?? '')).toContain('Already in chain');
    expect(readFile().fallbackModels).toEqual(['openai/gpt-4o']);
  });

  it('remove by 1-based index drops the right entry', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1', 'b/2', 'c/3'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('remove 2');
    expect(stripAnsi(res?.message ?? '')).toContain('removed');
    expect(readFile().fallbackModels).toEqual(['a/1', 'c/3']);
  });

  it('remove by exact reference works', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1', 'b/2'] });
    const cmd = buildFallbackCommand(ctx);
    await cmd.run('remove b/2');
    expect(readFile().fallbackModels).toEqual(['a/1']);
  });

  it('clear empties the explicit chain', async () => {
    const { ctx, readFile } = makeCtx({ fallbackModels: ['a/1'] });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('clear');
    expect(stripAnsi(res?.message ?? '')).toContain('cleared');
    expect(readFile().fallbackModels).toEqual([]);
  });

  it('auto off persists fallbackAuto=false', async () => {
    const { ctx, update, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('auto off');
    expect(stripAnsi(res?.message ?? '')).toContain('off');
    expect(readFile().fallbackAuto).toBe(false);
    expect(update).toHaveBeenCalledWith({ fallbackAuto: false });
  });

  it('profile set stores a named fallback chain', async () => {
    const { ctx, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('profile set fallback1 openai/gpt-5,anthropic/anthropic-test-model');
    expect(stripAnsi(res?.message ?? '')).toContain('profile fallback1');
    expect(readFile().fallbackProfiles).toEqual({
      fallback1: ['openai/gpt-5', 'anthropic/anthropic-test-model'],
    });
  });

  it('profile use selects a profile without clobbering the explicit chain', async () => {
    // It used to copy the profile's entries over `fallbackModels`, destroying
    // whatever the user had configured with no way back — and that copy was
    // the ONLY way a profile could take effect, because nothing read a
    // selected profile name.
    const { ctx, readFile } = makeCtx({
      fallbackProfiles: { fallback1: ['a/1', 'b/2'] },
      fallbackModels: ['keep/me'],
    });
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('profile use fallback1');
    expect(stripAnsi(res?.message ?? '')).toContain('fallback profile');
    expect(readFile().fallbackProfile).toBe('fallback1');
    expect(readFile().fallbackModels).toEqual(['keep/me']);
  });

  it('profile none deselects the profile', async () => {
    const { ctx, readFile } = makeCtx({
      fallbackProfiles: { fallback1: ['a/1'] },
      fallbackProfile: 'fallback1',
    });
    const cmd = buildFallbackCommand(ctx);
    await cmd.run('profile none');
    expect(readFile().fallbackProfile).toBeUndefined();
  });

  it('profile remove clears a selection pointing at the deleted profile', async () => {
    const { ctx, readFile } = makeCtx({
      fallbackProfiles: { fallback1: ['a/1'] },
      fallbackProfile: 'fallback1',
    });
    const cmd = buildFallbackCommand(ctx);
    await cmd.run('profile remove fallback1');
    expect(readFile().fallbackProfile).toBeUndefined();
    expect(readFile().fallbackProfiles).toEqual({});
  });

  it('fav add stores favorite models and only toggles strict smart fallback mode', async () => {
    const { ctx, readFile } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    await cmd.run('fav add openai/gpt-5');
    await cmd.run('fav only on');
    expect(readFile().favoriteModels).toEqual(['openai/gpt-5']);
    expect(readFile().favoriteModelsOnly).toBe(true);
  });

  it('rejects an unknown subcommand', async () => {
    const { ctx } = makeCtx();
    const cmd = buildFallbackCommand(ctx);
    const res = await cmd.run('frobnicate');
    expect(stripAnsi(res?.message ?? '')).toContain('Unknown subcommand');
  });

  describe('favorite validation on add', () => {
    it('rejects /fallback add for a ref that is not in favorites', async () => {
      const { ctx, readFile } = makeCtx({
        providers: { anthropic: { apiKey: 'k' } },
        favoriteModels: ['anthropic/claude-opus-4', 'openai/gpt-4o'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('add openai/gpt-5');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('Cannot add');
      expect(msg).toContain('not in favorites');
      expect(readFile().fallbackModels ?? []).toEqual([]);
    });

    it('accepts /fallback add when favorites list is empty (legacy no-enforcement mode)', async () => {
      const { ctx, readFile } = makeCtx({
        providers: { anthropic: { apiKey: 'k' } },
        favoriteModels: [],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('add anthropic/claude-opus-4');
      expect(stripAnsi(res?.message ?? '')).toContain('added');
      expect(readFile().fallbackModels).toEqual(['anthropic/claude-opus-4']);
    });

    it('accepts /fallback add outside the saved model list but warns', async () => {
      // The saved model list is a drifting snapshot (re-auth rewrites it), and
      // the runtime no longer drops entries over it, so refusing here would
      // block a model the provider actually serves. Warn, don't block.
      const { ctx, readFile } = makeCtx({
        providers: {
          anthropic: { apiKey: 'k', models: ['claude-opus-4', 'claude-sonnet-4'] },
        },
        favoriteModels: ['anthropic/claude-opus-4', 'anthropic/claude-99-new'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('add anthropic/claude-99-new');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('added');
      expect(msg).toContain('not in anthropic saved model list');
      expect(readFile().fallbackModels).toEqual(['anthropic/claude-99-new']);
    });
  });

  describe('favorite validation on profile set', () => {
    it('rejects profile set with any non-favorite entry', async () => {
      const { ctx, readFile } = makeCtx({
        providers: { openai: { apiKey: 'k' } },
        favoriteModels: ['openai/gpt-4o'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('profile set fast openai/gpt-4o,anthropic/claude-3');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('Cannot save profile');
      expect(msg).toContain('anthropic/claude-3');
      expect(msg).toContain('not in favorites');
      expect(readFile().fallbackProfiles ?? {}).toEqual({});
    });

    it('accepts profile set for an entry outside the saved model list', async () => {
      // Same reasoning as `add`: the list drifts, and refusing here is how a
      // profile ends up unable to name a model the provider actually serves.
      const { ctx, readFile } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
        favoriteModels: ['openai/gpt-4o', 'openai/gpt-5-new'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('profile set fast openai/gpt-4o,openai/gpt-5-new');
      expect(stripAnsi(res?.message ?? '')).toContain('profile fast');
      expect(readFile().fallbackProfiles).toEqual({
        fast: ['openai/gpt-4o', 'openai/gpt-5-new'],
      });
    });

    it('accepts profile set when every entry is valid (favorite + allow-list)', async () => {
      const { ctx, readFile } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
        favoriteModels: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('profile set fast openai/gpt-4o,openai/gpt-4o-mini');
      expect(stripAnsi(res?.message ?? '')).toContain('profile fast');
      expect(readFile().fallbackProfiles).toEqual({
        fast: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
      });
    });
  });

  describe('fav add allow-list validation', () => {
    it('rejects fav add when model not in provider allow-list', async () => {
      const { ctx, readFile } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
        favoriteModels: [],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('fav add openai/gpt-99');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('Cannot favorite');
      expect(msg).toContain('not in openai model list');
      expect(readFile().favoriteModels ?? []).toEqual([]);
    });

    it('accepts fav add when model is in provider allow-list', async () => {
      const { ctx, readFile } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
        favoriteModels: [],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('fav add openai/gpt-4o-mini');
      expect(stripAnsi(res?.message ?? '')).toContain('favorite added');
      expect(readFile().favoriteModels).toEqual(['openai/gpt-4o-mini']);
    });

    it('accepts fav add when provider has no models allow-list (no enforcement)', async () => {
      const { ctx, readFile } = makeCtx({
        providers: { anthropic: { apiKey: 'k' } },
        favoriteModels: [],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('fav add anthropic/claude-opus-4');
      expect(stripAnsi(res?.message ?? '')).toContain('favorite added');
      expect(readFile().favoriteModels).toEqual(['anthropic/claude-opus-4']);
    });
  });

  describe('currentView inactive warnings', () => {
    it('flags a profile entry missing from the saved model list as advisory only', async () => {
      // It used to be labelled "inactive", which was accurate when the runtime
      // dropped it. The runtime tries it now, so the label must not claim the
      // entry is dead.
      const { ctx } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] },
        },
        fallbackProfiles: {
          fast: ['openai/gpt-4o', 'openai/not-a-real-model'],
        },
        favoriteModels: [],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('fast');
      expect(msg).toContain('openai/not-a-real-model');
      expect(msg).toContain('not in openai saved model list');
      expect(msg).toContain('will still be tried');
      expect(msg).not.toContain('inactive');
    });

    it('flags a favorite entry that is not in the provider model list', async () => {
      const { ctx } = makeCtx({
        providers: {
          openai: { apiKey: 'k', models: ['gpt-4o'] },
        },
        favoriteModels: ['openai/gpt-4o', 'openai/gpt-5-not-real'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('not in openai saved model list');
      expect(msg).toContain('openai/gpt-5-not-real');
    });

    it('does not flag entries when the provider has no models allow-list', async () => {
      const { ctx } = makeCtx({
        providers: { anthropic: { apiKey: 'k' } },
        fallbackProfiles: { fast: ['anthropic/claude-opus-4'] },
        favoriteModels: ['anthropic/claude-opus-4'],
      });
      const cmd = buildFallbackCommand(ctx);
      const res = await cmd.run('');
      const msg = stripAnsi(res?.message ?? '');
      expect(msg).toContain('anthropic/claude-opus-4');
      expect(msg).not.toContain('inactive');
    });
  });
});
