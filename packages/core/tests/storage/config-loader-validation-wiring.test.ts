/**
 * Regression: `validateConfigBehavior` names and drops a misspelled hook event
 * and an invalid `context.keepTokens`, but `DefaultConfigLoader.load()` ran its
 * own private copy of the validator that predated both checks — the extracted
 * function had no production caller. A `"preToolUse"` guard hook in a real
 * config loaded silently and never fired. These tests go through `load()`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultConfigLoader } from '../../src/storage/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

let projectRoot: string;
let userHome: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-wiring-proj-'));
  userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-wiring-home-'));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(userHome, { recursive: true, force: true });
});

async function load(profile: Record<string, unknown>) {
  const paths = resolveWstackPaths({ projectRoot, userHome });
  const file = paths.profileConfig('default');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(profile));
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) } as unknown as Logger;
  const cfg = await new DefaultConfigLoader({ paths, logger }).load();
  return { cfg, warnings };
}

const hook = (command: string) => [{ type: 'command', command }];

describe('DefaultConfigLoader.load behavior validation', () => {
  it('drops and names a misspelled hook event', async () => {
    const { cfg, warnings } = await load({
      hooks: { preToolUse: hook('guard.sh'), PreToolUse: hook('ok.sh') },
    });
    expect(Object.keys(cfg.hooks ?? {})).toEqual(['PreToolUse']);
    expect(warnings.some((w) => w.includes('unknown event "preToolUse"'))).toBe(true);
  });

  it('drops a non-positive keepTokens and floors a fractional one', async () => {
    const bad = await load({ context: { keepTokens: -5 } });
    expect(bad.cfg.context.keepTokens).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes('context.keepTokens -5'))).toBe(true);
    expect((await load({ context: { keepTokens: 1500.7 } })).cfg.context.keepTokens).toBe(1500);
  });

  it('keeps a valid config untouched and quiet', async () => {
    const { cfg, warnings } = await load({
      hooks: { PreToolUse: hook('a'), SessionEnd: hook('b') },
      context: { keepTokens: 2000 },
    });
    expect(Object.keys(cfg.hooks ?? {})).toEqual(['PreToolUse', 'SessionEnd']);
    expect(cfg.context.keepTokens).toBe(2000);
    expect(warnings).toEqual([]);
  });
});
