/**
 * WS-036 — MCP server env is where server credentials live, and `mcp.list`
 * echoed it verbatim over the WebSocket to the browser.
 *
 * Masking a value is only half a fix: the WebUI prefills its edit form from
 * exactly that payload, so a caller that sends the mask back must not
 * overwrite the stored secret with the placeholder. That would destroy the
 * user's credential — a worse outcome than the leak. `buildConfig` restores
 * masked values from the existing config, and these pin that round-trip.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_ENV_MASK, updateMcp } from '../src/manage.js';

let dir: string;
let configPath: string;

const STORED_SECRET = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function seed(env: Record<string, string>): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        demo: { name: 'demo', transport: 'stdio', command: 'node', env, enabled: false },
      },
    }),
  );
}

async function storedEnv(): Promise<Record<string, string> | undefined> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  };
  return raw.mcpServers['demo']?.env;
}

/** The servers are seeded `enabled: false`, so update takes the disabled path. */
const deps = () =>
  ({
    configPath,
    registry: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
      markDisabled: vi.fn(),
    },
  }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-env-mask-'));
  configPath = join(dir, 'config.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('MCP env masking round-trip (WS-036)', () => {
  it('keeps the stored secret when the caller echoes the mask back', async () => {
    await seed({ GITHUB_TOKEN: STORED_SECRET, NODE_ENV: 'production' });

    const result = await updateMcp(
      {
        name: 'demo',
        env: { GITHUB_TOKEN: MCP_ENV_MASK, NODE_ENV: 'production' },
      } as never,
      deps(),
    );

    expect(result.ok).toBe(true);
    expect(await storedEnv()).toEqual({
      GITHUB_TOKEN: STORED_SECRET,
      NODE_ENV: 'production',
    });
  });

  it('accepts a genuine replacement — masking must not make a value unwritable', async () => {
    await seed({ GITHUB_TOKEN: STORED_SECRET });

    await updateMcp(
      { name: 'demo', env: { GITHUB_TOKEN: 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } } as never,
      deps(),
    );

    expect((await storedEnv())?.['GITHUB_TOKEN']).toBe('ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  });

  it('never persists the placeholder itself for an unknown key', async () => {
    // No stored value to restore, so the entry is dropped rather than written
    // as the literal mask — which would then be handed to the MCP server as
    // its credential.
    await seed({ GITHUB_TOKEN: STORED_SECRET });

    await updateMcp(
      { name: 'demo', env: { GITHUB_TOKEN: MCP_ENV_MASK, NEW_KEY: MCP_ENV_MASK } } as never,
      deps(),
    );

    const env = await storedEnv();
    expect(env?.['GITHUB_TOKEN']).toBe(STORED_SECRET);
    expect(env?.['NEW_KEY']).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(MCP_ENV_MASK);
  });

  it('leaves an env map with no masks structurally untouched', async () => {
    await seed({ NODE_ENV: 'production' });
    await updateMcp({ name: 'demo', env: { NODE_ENV: 'test' } } as never, deps() as never);
    expect(await storedEnv()).toEqual({ NODE_ENV: 'test' });
  });

  it('removes an env entry the caller dropped', async () => {
    await seed({ GITHUB_TOKEN: STORED_SECRET, STALE: 'x' });
    await updateMcp({ name: 'demo', env: { GITHUB_TOKEN: MCP_ENV_MASK } } as never, deps());
    const env = await storedEnv();
    expect(env?.['STALE']).toBeUndefined();
    expect(env?.['GITHUB_TOKEN']).toBe(STORED_SECRET);
  });
});
