import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultConfigLoader } from '../../src/storage/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

const quiet = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

describe('DefaultConfigLoader profile file it cannot parse', () => {
  let projectRoot: string;
  let userHome: string;
  let paths: ReturnType<typeof resolveWstackPaths>;
  let profile: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-unparse-proj-'));
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-unparse-home-'));
    paths = resolveWstackPaths({ projectRoot, userHome });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ version: 1, activeProfile: 'default' }),
    );
    profile = paths.profileConfig('default');
    await fs.mkdir(path.dirname(profile), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(userHome, { recursive: true, force: true });
  });

  const load = () => new DefaultConfigLoader({ paths, logger: quiet }).load();

  it('leaves a hand-edit typo on disk instead of replacing it with defaults', async () => {
    const text = '{ "provider": "mine", "mcpServers": { "a": { "command": "x" } }, }';
    await fs.writeFile(profile, text);
    const cfg = await load();
    expect(cfg.context.mode).toBe('balanced');
    expect(await fs.readFile(profile, 'utf8')).toBe(text);
  });

  it('still self-heals an empty profile file', async () => {
    await fs.writeFile(profile, '');
    await load();
    expect(JSON.parse(await fs.readFile(profile, 'utf8'))).toHaveProperty('context');
  });

  it('reads a profile written with a UTF-8 BOM', async () => {
    await fs.writeFile(profile, `﻿${JSON.stringify({ provider: 'from-bom' })}`);
    const cfg = await load();
    expect(cfg.provider).toBe('from-bom');
    expect(await fs.readFile(profile, 'utf8')).toContain('from-bom');
  });

  it('reads a project-local config written with a UTF-8 BOM', async () => {
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(paths.projectLocalConfig, `﻿${JSON.stringify({ model: 'bom-model' })}`);
    expect((await load()).model).toBe('bom-model');
  });
});
