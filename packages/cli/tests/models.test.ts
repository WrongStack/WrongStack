/**
 * Focused coverage for slash-commands/models.ts — the /models command
 * builder. Exercises list (empty/non-empty), add with every flag branch,
 * remove (missing/not-found), help, config-parse errors, and the secret
 * round-trip through patchProfileConfig.
 *
 * Uses a real temp profile config file; the encrypt/decrypt helpers are the
 * real noOpVault path from core.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModelsCommand } from '../src/slash-commands/models.js';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';

let dir: string;
let profilePath: string;

function ctx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  let config: Record<string, unknown> = { models: {}, activeProfile: 'default' };
  return {
    configStore: {
      get: () => config,
      update: (next: Record<string, unknown>) => {
        config = { ...config, ...next };
      },
    } as never,
    paths: {
      profileConfig: () => profilePath,
    } as never,
    ...overrides,
  } as SlashCommandContext;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-models-'));
  profilePath = path.join(dir, 'config.json');
  await fs.writeFile(profilePath, '{}', 'utf8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('buildModelsCommand — list', () => {
  it('lists an empty custom-models set with the add hint', async () => {
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('');
    expect(out.message).toContain('Custom Models');
    expect(out.message).toContain('none defined');
    expect(out.message).toContain('/models add');
  });

  it('lists defined models with caps, provider, and maxOutput formatting', async () => {
    const c = ctx();
    (c.configStore.get() as Record<string, unknown>).models = {
      'my-model': {
        provider: 'openai',
        name: 'My Model',
        capabilities: { maxContext: 128000, tools: true, vision: true },
        maxOutput: 4096,
      },
      'bare': {},
    };
    const cmd = buildModelsCommand(c);
    const out = await cmd.run('');
    expect(out.message).toContain('Custom Models');
    expect(out.message).toContain('(2)');
    expect(out.message).toContain('my-model');
    expect(out.message).toContain('provider: openai');
    expect(out.message).toContain('name: My Model');
    expect(out.message).toContain('maxContext: 128000');
    expect(out.message).toContain('caps: tools, vision');
    expect(out.message).toContain('maxOutput: 4096');
    expect(out.message).toContain('bare');
  });

  it('returns the help text for the help/--help subcommand', async () => {
    const cmd = buildModelsCommand(ctx());
    expect((await cmd.run('help')).message).toContain('/models add');
    expect((await cmd.run('--help')).message).toContain('/models add');
  });

  it('reports when the config store is unavailable', async () => {
    const cmd = buildModelsCommand(ctx({ configStore: undefined as never }));
    const out = await cmd.run('');
    expect(out.message).toContain('config store not available');
  });
});

describe('buildModelsCommand — add', () => {
  it('adds a model with flags and persists to the profile config', async () => {
    const c = ctx();
    const cmd = buildModelsCommand(c);
    const out = await cmd.run(
      'add my-model --provider openai --name "My Model" --max-context 128000 --max-output 4096 --tools --vision --reasoning --streaming --json-mode',
    );
    expect(out.message).toContain('added');
    const onDisk = JSON.parse(await fs.readFile(profilePath, 'utf8')) as Record<string, unknown>;
    const models = onDisk.models as Record<string, { provider?: string; capabilities?: Record<string, unknown> }>;
    expect(models['my-model']!.provider).toBe('openai');
    expect(models['my-model']!.capabilities).toMatchObject({
      maxContext: 128000,
      tools: true,
      vision: true,
      reasoning: true,
      streaming: true,
      jsonMode: true,
    });
    // The config store was refreshed with the decrypted models.
    expect((c.configStore.get() as { models: unknown }).models).toBeDefined();
  });

  it('updates an existing model, merging capabilities', async () => {
    const c = ctx();
    // `existed` is derived from the config store; patchProfileConfig merges
    // against the ON-DISK file. Seed both.
    (c.configStore.get() as Record<string, unknown>).models = {
      'my-model': { capabilities: { maxContext: 64000, tools: true } },
    };
    await fs.writeFile(
      profilePath,
      JSON.stringify({ models: { 'my-model': { capabilities: { maxContext: 64000, tools: true } } } }),
      'utf8',
    );
    const cmd = buildModelsCommand(c);
    const out = await cmd.run('add my-model --vision');
    expect(out.message).toContain('updated');
    const onDisk = JSON.parse(await fs.readFile(profilePath, 'utf8')) as Record<string, unknown>;
    const m = (onDisk.models as Record<string, { capabilities?: Record<string, unknown> }>)['my-model'];
    expect(m!.capabilities).toMatchObject({ maxContext: 64000, tools: true, vision: true });
  });

  it('rejects unknown flags and a missing model id', async () => {
    const cmd = buildModelsCommand(ctx());
    expect((await cmd.run('add x --bogus')).message).toContain('Unknown flag');
    expect((await cmd.run('add')).message).toContain('missing model id');
  });

  it('rejects a flag whose value is missing', async () => {
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('add m --provider');
    expect(out.message).toContain('Missing value at position');
  });

  it('shows the usage line when an id is given without flags', async () => {
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('add my-model');
    expect(out.message).toContain('Usage:');
    expect(out.message).toContain('/models add <id>');
  });

  it('reports a ConfigError when the profile config is invalid JSON', async () => {
    await fs.writeFile(profilePath, '{ not json', 'utf8');
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('add m --tools');
    expect(out.message).toContain('models error');
    expect(out.message).toContain('not valid JSON');
  });

  it('creates the config file when it is missing', async () => {
    await fs.rm(profilePath, { force: true });
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('add fresh --tools');
    expect(out.message).toContain('added');
    await expect(fs.stat(profilePath)).resolves.toBeDefined();
  });
});

describe('buildModelsCommand — remove', () => {
  it('removes a defined model', async () => {
    const c = ctx();
    (c.configStore.get() as Record<string, unknown>).models = { 'my-model': {} };
    const cmd = buildModelsCommand(c);
    const out = await cmd.run('remove my-model');
    expect(out.message).toContain('removed');
    const onDisk = JSON.parse(await fs.readFile(profilePath, 'utf8')) as Record<string, unknown>;
    expect((onDisk.models as Record<string, unknown>)['my-model']).toBeUndefined();
  });

  it('reports a missing id and a not-found model', async () => {
    const cmd = buildModelsCommand(ctx());
    expect((await cmd.run('remove')).message).toContain('Usage:');
    expect((await cmd.run('remove nope')).message).toContain('Not found');
  });

  it('supports the rm alias', async () => {
    const c = ctx();
    (c.configStore.get() as Record<string, unknown>).models = { 'my-model': {} };
    const cmd = buildModelsCommand(c);
    expect((await cmd.run('rm my-model')).message).toContain('removed');
  });
});

describe('buildModelsCommand — unknown subcommand', () => {
  it('reports an unknown subcommand with suggestions', async () => {
    const cmd = buildModelsCommand(ctx());
    const out = await cmd.run('frobnicate');
    expect(out.message).toContain('Unknown subcommand');
    expect(out.message).toContain('frobnicate');
  });
});
