/**
 * Focused coverage for slash-commands/modelcaps.ts — the /modelcaps command
 * builder. Exercises summary (empty/non-empty matrix), cache load
 * (enveloped/plain/absent), provider + per-model fragment filtering, key
 * presence markers, and the no-models-matched path.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModelCapsCommand } from '../src/slash-commands/modelcaps.js';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';

let dir: string;
let cachePath: string;

function ctx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    configStore: {
      get: () => ({
        provider: 'openai',
        model: 'gpt-4o',
        modelMatrix: {},
        providers: {},
      }),
      update: () => undefined,
    } as never,
    paths: {
      modelsCache: cachePath,
      profileConfig: () => path.join(dir, 'profile.json'),
    } as never,
    ...overrides,
  } as SlashCommandContext;
}

async function writeCache(providers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    cachePath,
    JSON.stringify({ fetchedAt: 1, url: 'x', payload: providers }),
    'utf8',
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-modelcaps-'));
  cachePath = path.join(dir, 'models.dev.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('buildModelCapsCommand — summary', () => {
  it('shows leader fallback with no matrix overrides', async () => {
    const cmd = buildModelCapsCommand(ctx());
    const out = await cmd.run('summary');
    expect(out.message).toContain('Agent-Type → Model Mapping');
    expect(out.message).toContain('leader');
    expect(out.message).toContain('openai/gpt-4o');
    expect(out.message).toContain('No matrix overrides');
  });

  it('lists matrix overrides including the * default', async () => {
    const cmd = buildModelCapsCommand(
      ctx({
        configStore: {
          get: () => ({
            provider: 'openai',
            model: 'gpt-4o',
            modelMatrix: {
              bug: { provider: 'anthropic', model: 'claude' },
              '*': { model: 'gpt-4o-mini' },
            },
          }),
          update: () => undefined,
        } as never,
      }),
    );
    const out = await cmd.run('summary');
    expect(out.message).toContain('bug');
    expect(out.message).toContain('anthropic/claude');
    expect(out.message).toContain('* (default)');
    expect(out.message).toContain('gpt-4o-mini');
    expect(out.message).toContain('Resolution order');
  });
});

describe('buildModelCapsCommand — cache loading', () => {
  it('returns an error when no cache path is available', async () => {
    const cmd = buildModelCapsCommand(ctx({ paths: undefined as never }));
    const out = await cmd.run('');
    expect(out.message).toContain('Models cache path not available');
  });

  it('reports a missing cache file gracefully', async () => {
    const cmd = buildModelCapsCommand(ctx());
    const out = await cmd.run('');
    expect(out.message).toContain('Models cache not available');
    expect(out.message).toContain('Expected at:');
  });

  it('lists enveloped cache providers with key markers and prices', async () => {
    await writeCache({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@openai/models',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            limit: { context: 128000, output: 16384 },
            cost: { input: 2.5, output: 10 },
          },
          'gpt-4o-mini': {
            id: 'gpt-4o-mini',
            limit: { context: 200000, output: 0 },
            cost: { input: 0.15 },
          },
        },
      },
    });
    const cmd = buildModelCapsCommand(
      ctx({
        configStore: {
          get: () => ({
            provider: 'openai',
            model: 'gpt-4o',
            providers: {
              openai: { apiKey: 'sk-test' },
            },
          }),
          update: () => undefined,
        } as never,
      }),
    );
    const out = await cmd.run('');
    expect(out.message).toContain('Available Models');
    expect(out.message).toContain('● openai');
    expect(out.message).toContain('🔴 128.0k'); // exactly 128k → red (strict >)
    expect(out.message).toContain('🟡 200.0k'); // 200k → yellow
    expect(out.message).toContain('out 16.4k');
    expect(out.message).toContain('$2.50/M tok');
    expect(out.message).toContain('2 model(s)');
  });

  it('filters by provider fragment and per-model fragment after a slash', async () => {
    await writeCache({
      openai: { id: 'openai', name: 'OpenAI', models: { a: { id: 'alpha' }, b: { id: 'beta' } } },
      anthropic: { id: 'anthropic', name: 'Anthropic', models: { c: { id: 'gamma' } } },
    });
    const cmd = buildModelCapsCommand(ctx());
    const providerOut = await cmd.run('anthropic');
    expect(providerOut.message).toContain('anthropic');
    expect(providerOut.message).not.toContain('openai');
    const modelOut = await cmd.run('openai/bet');
    expect(modelOut.message).toContain('beta');
    expect(modelOut.message).not.toContain('alpha');
  });

  it('shows the no-models and no-key markers', async () => {
    await writeCache({
      openai: { id: 'openai', name: 'OpenAI', models: {} },
      anthropic: { id: 'anthropic', name: 'Anthropic' },
    });
    const cmd = buildModelCapsCommand(ctx());
    const out = await cmd.run('nope');
    expect(out.message).toContain('No models matched');
    const allOut = await cmd.run('');
    expect(allOut.message).toContain('○ openai');
    expect(allOut.message).toContain('no models listed');
  });

  it('marks a provider keyed via the apiKeys array', async () => {
    await writeCache({
      openai: { id: 'openai', name: 'OpenAI', models: { a: { id: 'alpha' } } },
    });
    const cmd = buildModelCapsCommand(
      ctx({
        configStore: {
          get: () => ({
            providers: { openai: { apiKeys: [{ apiKey: 'k' }] } },
          }),
          update: () => undefined,
        } as never,
      }),
    );
    const out = await cmd.run('');
    expect(out.message).toContain('● openai');
  });

  it('marks a provider without any usable key as unkeyed', async () => {
    await writeCache({
      openai: { id: 'openai', name: 'OpenAI', models: { a: { id: 'alpha' } } },
    });
    // Provider exists in config but with an empty apiKey and an apiKeys
    // array whose entries carry no key — the final `return false` in hasKey.
    const cmd = buildModelCapsCommand(
      ctx({
        configStore: {
          get: () => ({
            providers: { openai: { apiKey: '', apiKeys: [{ apiKey: undefined }] } },
          }),
          update: () => undefined,
        } as never,
      }),
    );
    const out = await cmd.run('');
    expect(out.message).toContain('○ openai');
  });
});
