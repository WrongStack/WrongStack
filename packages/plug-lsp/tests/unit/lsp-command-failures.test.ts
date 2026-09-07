import { beforeEach, describe, expect, it, vi } from 'vitest';

const persist = vi.hoisted(() => ({ persistServerConfig: vi.fn() }));

vi.mock('../../src/config-persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config-persist.js')>();
  return { ...actual, persistServerConfig: persist.persistServerConfig };
});

const install = vi.hoisted(() => ({ installLang: vi.fn() }));

vi.mock('../../src/slash-commands/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/slash-commands/install.js')>();
  return { ...actual, installLang: install.installLang };
});

import { buildLspCommand } from '../../src/slash-commands/lsp.js';
import type { PlugLSPConfig } from '../../src/types.js';

const server = { command: 'ts-ls', languages: ['typescript'], enabled: true };

function ctx(overrides: { start?: () => Promise<void>; autoDiscover?: boolean } = {}) {
  return {
    registry: {
      list: vi.fn(() => []),
      upsertServer: vi.fn(async () => {}),
      removeServer: vi.fn(async () => {}),
      setServerEnabled: vi.fn(async () => server),
      start: vi.fn(overrides.start ?? (async () => {})),
    },
    tracker: { list: vi.fn(() => []) },
    cfg: {
      autoStart: 'lazy',
      severityFilter: ['error'],
      maxDiagnosticsPerFile: 10,
      maxDiagnosticsTotal: 20,
      autoDiscover: overrides.autoDiscover ?? true,
      servers: { typescript: server },
    } as unknown as PlugLSPConfig,
    cwd: process.cwd(),
  };
}

async function run(context: ReturnType<typeof ctx>, args: string): Promise<string> {
  const result = await buildLspCommand(context as never).run!(args);
  if (!result?.message) throw new Error('LSP command returned no message');
  return result.message;
}

describe('/lsp failure paths', () => {
  beforeEach(() => {
    persist.persistServerConfig.mockReset();
    persist.persistServerConfig.mockResolvedValue('/tmp/config.local.json');
    install.installLang.mockReset();
    install.installLang.mockResolvedValue({ alreadyInstalled: true });
  });

  it('install keeps the binary but says the config could not be written', async () => {
    persist.persistServerConfig.mockRejectedValueOnce(new Error('disk full'));
    const message = await run(ctx(), 'install typescript');
    expect(message).toContain('Could not save the server to your config');
    expect(message).toContain('disk full');
    expect(message).toContain('add it manually');
  });

  it('install reports a server that saved but would not start', async () => {
    const message = await run(
      ctx({
        start: async () => {
          throw new Error('exited immediately');
        },
      }),
      'install typescript',
    );
    expect(message).toContain('Saved, but the server did not start');
    expect(message).toContain('exited immediately');
    expect(message).toContain('/lsp restart typescript');
  });

  it('stringifies a thrown non-Error', async () => {
    // Some install paths reject with a string; the message must still read.
    persist.persistServerConfig.mockRejectedValueOnce('plain string failure');
    expect(await run(ctx(), 'install typescript')).toContain('plain string failure');
  });

  it('remove reports a config write failure and leaves the server mounted', async () => {
    persist.persistServerConfig.mockRejectedValueOnce(new Error('read-only'));
    const context = ctx();
    expect(await run(context, 'remove typescript')).toContain('Could not update the config');
    expect(context.registry.removeServer).not.toHaveBeenCalled();
    expect(context.cfg.servers['typescript']).toBeDefined();
  });

  it('remove warns about rediscovery only when autoDiscover is on', async () => {
    expect(await run(ctx({ autoDiscover: true }), 'remove typescript')).toContain(
      'rediscovered next session',
    );
    expect(await run(ctx({ autoDiscover: false }), 'remove typescript')).not.toContain(
      'rediscovered next session',
    );
  });

  it('enable reports a config write failure without touching the registry', async () => {
    persist.persistServerConfig.mockRejectedValueOnce(new Error('read-only'));
    const context = ctx();
    expect(await run(context, 'enable typescript')).toContain('Could not update the config');
    expect(context.registry.setServerEnabled).not.toHaveBeenCalled();
  });

  it('enable reports a server that was turned on but would not start', async () => {
    const message = await run(
      ctx({
        start: async () => {
          throw new Error('port busy');
        },
      }),
      'enable typescript',
    );
    expect(message).toContain('Enabled:');
    expect(message).toContain('But it did not start');
    expect(message).toContain('port busy');
  });

  it('enable without a name returns help', async () => {
    expect(await run(ctx(), 'enable')).toContain('Usage:');
  });
});
