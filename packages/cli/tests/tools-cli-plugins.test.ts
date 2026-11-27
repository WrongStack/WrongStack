/**
 * `wstack tools` and official plugin tools.
 *
 * The tools subcommand used to serve built-in tools only, so a plugin tool was
 * "Unknown tool" with no hint at all. Enabled one-shot plugins are now loaded
 * (same enablement as a session) and a tool of a one-shot plugin that is not
 * enabled exits 3 naming the plugin to enable.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runToolsCli, type ToolsCliIo } from '../src/subcommands/handlers/tools-cli.js';
import { loadGatewayPlugins } from '../src/tool-gateway-plugins.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cli-plugins-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function capture(): ToolsCliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    readStdin: async () => '',
  };
  return io;
}

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return r;
}

describe('wstack tools with official plugins', () => {
  it('names the plugin to enable for a tool of a disabled one-shot plugin', async () => {
    const io = capture();
    const code = await runToolsCli(
      'run',
      ['change_risk_analyze'],
      {
        config: { tools: {}, features: {}, plugins: [] },
        toolRegistry: registry(),
        cwd: root,
        projectRoot: root,
        flags: {},
        renderer: {},
      } as never,
      io,
    );
    expect(code).toBe(3);
    expect(io.err).toContain('"change-risk-classifier" plugin');
    expect(io.err).toContain('wstack plugin enable change-risk-classifier');
  });

  it('registers only enabled one-shot plugins and disposes them', async () => {
    const r = registry();
    const before = r.list().length;
    const host = await loadGatewayPlugins({
      registry: r,
      config: {
        tools: {},
        features: {},
        plugins: [
          { name: 'release-readiness', enabled: true },
          { name: 'file-watcher', enabled: true },
        ],
      } as never,
    });
    expect(host.loaded).toEqual(['release-readiness']);
    expect(host.failed).toEqual([]);
    expect(r.get('release_readiness_analyze')).toBeTruthy();
    expect(r.get('watch_start')).toBeUndefined();
    await host.dispose();
    expect(r.list().length).toBe(before);
  });

  it('loads nothing when plugins are switched off', async () => {
    const host = await loadGatewayPlugins({
      registry: registry(),
      config: {
        tools: {},
        features: { plugins: false },
        plugins: [{ name: 'release-readiness', enabled: true }],
      } as never,
    });
    expect(host.loaded).toEqual([]);
  });
});
