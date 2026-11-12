import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { defaultPluginTrustPath, readPluginTrustStore } from '@wrongstack/core/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLoadCommand } from '../src/slash-commands/session.js';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';
import { pluginCmd } from '../src/subcommands/handlers/plugin-usage.js';
import { sessionsCmd } from '../src/subcommands/handlers/sessions-config.js';

describe('wstack plugin CLI subcommand flag restoration & custom globalRoot', () => {
  let root = '';
  let globalRoot = '';
  let projectRoot = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wstack-cli-plug-'));
    globalRoot = join(root, 'global-home');
    projectRoot = join(root, 'project');
    await mkdir(join(globalRoot, 'plugins'), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins, lists, and unpins an external .ts plugin when parseArgs stripped --list and --remove', async () => {
    const pluginFile = join(globalRoot, 'plugins', 'hello-ts.ts');
    await writeFile(
      pluginFile,
      'export default { name: "hello-ts", apiVersion: "^0.1", setup() {} };\n',
    );
    const configPath = join(globalRoot, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1 }));

    const outputs: string[] = [];
    const makeDeps = (flags: Record<string, string | boolean>): SubcommandDeps =>
      ({
        config: { version: 1, provider: 'anthropic', model: 'claude' } as never as Config,
        flags,
        paths: {
          globalRoot,
          configDir: globalRoot,
          globalConfig: configPath,
          profileConfig: () => configPath,
          globalSkills: join(globalRoot, 'skills'),
          globalPrompts: join(globalRoot, 'prompts'),
          globalMemory: join(globalRoot, 'memory.md'),
          historyFile: join(globalRoot, 'history'),
          syncConfig: join(globalRoot, 'sync.json'),
          projectRoot,
        },
        renderer: {
          write: (msg: string) => outputs.push(msg),
          writeInfo: (msg: string) => outputs.push(msg),
          writeError: (msg: string) => outputs.push(msg),
          writeWarning: vi.fn(),
        },
      }) as never as SubcommandDeps;

    // 1. Pin `hello-ts` into custom `globalRoot`
    outputs.length = 0;
    const pinCode = await pluginCmd(['trust', 'hello-ts'], makeDeps({}));
    expect(pinCode).toBe(0);
    expect(outputs.join('')).toContain('Re-pinned "hello-ts"');

    const storeAfterPin = await readPluginTrustStore(defaultPluginTrustPath(globalRoot));
    expect(Object.keys(storeAfterPin.pinned)).toHaveLength(1);

    // 2. List via stripped `--list` flag (`deps.flags.list = true`, `args = ['trust']`)
    outputs.length = 0;
    const listCode = await pluginCmd(['trust'], makeDeps({ list: true }));
    expect(listCode).toBe(0);
    expect(outputs.join('')).toContain('Pinned external plugins (1)');

    // 3. Remove via stripped `--remove` flag (`deps.flags.remove = true`, `args = ['trust', 'hello-ts']`)
    outputs.length = 0;
    const rmCode = await pluginCmd(['trust', 'hello-ts'], makeDeps({ remove: true }));
    expect(rmCode).toBe(0);
    expect(outputs.join('')).toContain('Removed trust pin');

    const storeAfterRemove = await readPluginTrustStore(defaultPluginTrustPath(globalRoot));
    expect(Object.keys(storeAfterRemove.pinned)).toHaveLength(0);
  });

  it('displays ⎇ N branches · active: <name> indicators in both /sessions and wstack sessions', async () => {
    const fakeSummary = {
      id: 'sess_branched_01',
      startedAt: '2026-11-12T12:00:00.000Z',
      title: 'Explore CAS tree strategy',
      tokenTotal: 1450,
      toolCallCount: 4,
      iterationCount: 2,
      branchCount: 3,
      activeBranchName: 'approach-b',
      outcome: 'completed' as const,
    };
    const sessionStore = {
      list: vi.fn(async () => [fakeSummary]),
    };

    const subOutputs: string[] = [];
    const code = await sessionsCmd([], {
      flags: {},
      sessionStore,
      renderer: { write: (s: string) => subOutputs.push(s), writeError: vi.fn() },
    } as never);
    expect(code).toBe(0);
    expect(subOutputs.join('')).toContain('⎇ 3 branches · active: approach-b');

    const slashOutputs: string[] = [];
    const slashCmd = buildLoadCommand({
      sessionStore: sessionStore as never,
      renderer: { write: (s: string) => slashOutputs.push(s) } as never,
    } as never);
    const res = await slashCmd.run('');
    expect(res?.message).toContain('⎇ 3 branches · active: approach-b');
  });
});
