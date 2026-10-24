import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyHqAlertsConfig,
  HQ_ALERTS_CONFIG_VERSION,
  hqAlertsConfigFilePath,
  mutateHqAlertsConfig,
  readHqAlertsConfig,
  writeHqAlertsConfig,
} from '../src/index.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-alerts-config-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('alerts-config persistence (W2 #13)', () => {
  it('returns an empty config when the file does not exist (ENOENT)', async () => {
    const config = await readHqAlertsConfig(dataDir);
    expect(config.version).toBe(HQ_ALERTS_CONFIG_VERSION);
    expect(config.thresholds).toBeUndefined();
    expect(config.snoozes).toBeUndefined();
  });

  it('rejects an unsupported schema version', async () => {
    writeFileSync(
      hqAlertsConfigFilePath(dataDir),
      JSON.stringify({ version: 999, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    await expect(readHqAlertsConfig(dataDir)).rejects.toThrow(/unsupported version/);
  });

  it('rejects malformed JSON', async () => {
    writeFileSync(hqAlertsConfigFilePath(dataDir), '{ this is not json', 'utf8');
    await expect(readHqAlertsConfig(dataDir)).rejects.toThrow(/not valid JSON/);
  });

  it('writes and reads back a populated config', async () => {
    const original = {
      version: HQ_ALERTS_CONFIG_VERSION,
      updatedAt: new Date().toISOString(),
      thresholds: { costThresholdUsd: 123, staleMachineSeconds: 456, maxAgents: 7 },
      snoozes: { 'fleet-cost-threshold': Date.now() + 60_000 },
    };
    await writeHqAlertsConfig(dataDir, original);
    const round = await readHqAlertsConfig(dataDir);
    expect(round.thresholds).toEqual(original.thresholds);
    expect(round.snoozes).toEqual(original.snoozes);
  });

  it('emptyHqAlertsConfig returns the empty shape with the current version', () => {
    const empty = emptyHqAlertsConfig();
    expect(empty.version).toBe(HQ_ALERTS_CONFIG_VERSION);
    expect(empty.thresholds).toBeUndefined();
    expect(empty.snoozes).toBeUndefined();
    expect(typeof empty.updatedAt).toBe('string');
  });

  it('mutate applies a read-modify-write cycle', async () => {
    await writeHqAlertsConfig(dataDir, {
      version: HQ_ALERTS_CONFIG_VERSION,
      updatedAt: new Date().toISOString(),
      thresholds: { costThresholdUsd: 50 },
    });
    const next = await mutateHqAlertsConfig(dataDir, (current) => ({
      ...current,
      thresholds: { ...current.thresholds, costThresholdUsd: 200 },
    }));
    expect(next.thresholds?.costThresholdUsd).toBe(200);
    const round = await readHqAlertsConfig(dataDir);
    expect(round.thresholds?.costThresholdUsd).toBe(200);
  });

  it('mutate preserves the in-memory snooze set across a threshold change', async () => {
    const future = Date.now() + 60_000;
    await writeHqAlertsConfig(dataDir, {
      version: HQ_ALERTS_CONFIG_VERSION,
      updatedAt: new Date().toISOString(),
      thresholds: { costThresholdUsd: 50 },
      snoozes: { 'fleet-cost-threshold': future },
    });
    const next = await mutateHqAlertsConfig(dataDir, (current) => ({
      ...current,
      thresholds: { ...current.thresholds, maxAgents: 12 },
    }));
    expect(next.snoozes?.['fleet-cost-threshold']).toBe(future);
    const round = await readHqAlertsConfig(dataDir);
    expect(round.snoozes?.['fleet-cost-threshold']).toBe(future);
  });

  it('mutate on a fresh dataDir initializes from the empty config', async () => {
    const next = await mutateHqAlertsConfig(dataDir, (current) => ({
      ...current,
      thresholds: { costThresholdUsd: 999 },
    }));
    expect(next.thresholds?.costThresholdUsd).toBe(999);
    expect(next.version).toBe(HQ_ALERTS_CONFIG_VERSION);
  });

  it('mutate serializes concurrent mutations', async () => {
    await writeHqAlertsConfig(dataDir, {
      version: HQ_ALERTS_CONFIG_VERSION,
      updatedAt: new Date().toISOString(),
      thresholds: { costThresholdUsd: 50 },
    });
    await Promise.all([
      mutateHqAlertsConfig(dataDir, (c) => ({
        ...c,
        thresholds: { ...c.thresholds, costThresholdUsd: 100 },
      })),
      mutateHqAlertsConfig(dataDir, (c) => ({
        ...c,
        thresholds: { ...c.thresholds, maxAgents: 7 },
      })),
    ]);
    const round = await readHqAlertsConfig(dataDir);
    expect(round.thresholds?.maxAgents).toBe(7);
    expect([50, 100]).toContain(round.thresholds?.costThresholdUsd);
  });

  it('hqAlertsConfigFilePath joins under the data dir', () => {
    // Platform-agnostic: `path.join` returns either forward or backward
    // slashes depending on the runtime OS. The contract is "the file lives
    // at `<dataDir>/alerts-config.json`", which is what `path.join` already
    // guarantees regardless of separator.
    expect(join('/data', 'alerts-config.json')).toBe(hqAlertsConfigFilePath('/data'));
  });
});
