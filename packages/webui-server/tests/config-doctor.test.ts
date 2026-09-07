import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/core/types';
import { handleConfigDoctor } from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-doctor-'));
  configPath = path.join(tempDir, 'config.json');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function fakeWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    sent,
  };
}

const vault = {
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
} as never;

describe('WebUI Config Doctor', () => {
  it('previews missing defaults without writing', async () => {
    const original = JSON.stringify({ provider: 'custom', model: 'model-1' }, null, 2);
    await fs.writeFile(configPath, original);
    const ws = fakeWs();

    await handleConfigDoctor(ws as never, false, {
      profileConfigPath: configPath,
      vault,
      updateConfig: vi.fn(),
      applyRuntimeConfig: vi.fn(),
    });

    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(ws.sent[0]?.type).toBe('config.doctor.result');
    expect(ws.sent[0]?.payload['success']).toBe(true);
    expect(ws.sent[0]?.payload['changed']).toBe(true);
    expect(ws.sent[0]?.payload['applied']).toBe(false);
  });

  it('applies defaults, preserves identity, and creates a backup', async () => {
    const original = JSON.stringify({
      provider: 'custom',
      model: 'model-1',
      maxConcurrent: 'bad',
    });
    await fs.writeFile(configPath, original);
    const ws = fakeWs();
    const applyRuntimeConfig = vi.fn();
    const updateConfig = async (
      mutate: (config: Record<string, unknown>) => void,
    ): Promise<void> => {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
      mutate(config);
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    };

    await handleConfigDoctor(ws as never, true, {
      profileConfigPath: configPath,
      vault,
      updateConfig,
      applyRuntimeConfig,
    });

    const fixed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(fixed['provider']).toBe('custom');
    expect(fixed['model']).toBe('model-1');
    expect(fixed['maxConcurrent']).toBe(10);
    expect(fixed['context']).toMatchObject({ autoCompact: true, strategy: 'hybrid' });
    const backupPath = ws.sent[0]?.payload['backupPath'];
    expect(backupPath).toEqual(expect.any(String));
    expect(backupPath as string).toMatch(/\.last-\d+$/);
    expect(await fs.readFile(backupPath as string, 'utf8')).toBe(original);
    expect(applyRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 10 }));
    expect(ws.sent[0]?.payload['applied']).toBe(true);
  });

  it('reports invalid JSON without overwriting it', async () => {
    await fs.writeFile(configPath, '{broken');
    const ws = fakeWs();

    await handleConfigDoctor(ws as never, true, {
      profileConfigPath: configPath,
      vault,
      updateConfig: vi.fn(),
      applyRuntimeConfig: (_config: Config) => undefined,
    });

    expect(ws.sent[0]?.payload['success']).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe('{broken');
  });
});
