import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPiMcpServers } from '../../../scripts/pi-acp-mcp-extension.mjs';
import { prepareAcpLaunch } from '../src/client/acp-launch-compat.js';
import { ACPSession } from '../src/client/acp-session.js';
import type { McpServer } from '../src/types/acp-v1.js';

const servers: McpServer[] = [
  {
    name: 'wrongstack-mailbox',
    command: '/wstack',
    args: ['mcp', 'serve', 'mailbox', '--actor=worker-a', '--session-id=owner'],
    env: [{ name: 'MODE', value: 'test' }],
  },
  {
    name: 'fleet',
    type: 'http',
    url: 'http://127.0.0.1:1234',
    headers: [{ name: 'Authorization', value: 'Bearer fixture-value' }],
  },
];
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('native startup MCP compatibility', () => {
  it('keeps per-worker identity and native HTTP headers in a private Copilot config', async () => {
    const launch = await prepareAcpLaunch({
      command: 'copilot',
      args: ['--acp'],
      projectRoot: '/project',
      role: 'copilot',
      mcpServers: servers,
    });
    const file = launch.args.at(-1)!.slice(1);
    try {
      const config = JSON.parse(await readFile(file, 'utf8'));
      expect(config.mcpServers['wrongstack-mailbox']).toMatchObject({
        type: 'local',
        args: servers[0] && 'args' in servers[0] ? servers[0].args : [],
        env: { MODE: 'test' },
      });
      expect(config.mcpServers.fleet).toMatchObject({
        type: 'http',
        headers: { Authorization: 'Bearer fixture-value' },
      });
      expect(launch.args.slice(0, 2)).toEqual(['--acp', '--additional-mcp-config']);
    } finally {
      await launch.dispose();
    }
    expect(existsSync(file)).toBe(false);
    await launch.dispose();
  });

  it('does not change another agent or an empty server configuration', async () => {
    for (const input of [
      { role: 'claude-code', mcpServers: servers },
      { role: 'copilot', mcpServers: [] },
    ]) {
      const launch = await prepareAcpLaunch({
        command: 'agent',
        args: ['stdio'],
        projectRoot: '/p',
        ...input,
      });
      expect(launch.args).toEqual(['stdio']);
      expect(launch.env).toBeUndefined();
      await launch.dispose();
    }
  });

  it('injects Pi MCP definitions only with the explicit extension opt-in', async () => {
    const base = { command: 'pi-acp', projectRoot: '/p', role: 'pi-acp', mcpServers: servers };
    const untouched = await prepareAcpLaunch(base);
    expect(untouched.env).toBeUndefined();
    const env = { WRONGSTACK_PI_MCP_EXTENSION: '/extension.mjs', KEEP: 'original' };
    const launch = await prepareAcpLaunch({ ...base, env });
    expect(JSON.parse(launch.env!.WRONGSTACK_PI_SESSION_MCP!)).toEqual(servers);
    expect(launch.env?.KEEP).toBe('original');
    expect(env).not.toHaveProperty('WRONGSTACK_PI_SESSION_MCP');
  });

  it.each([false, true])(
    'cleans up the native config after a real peer closes or fails (failure=%s)',
    async (fail) => {
      const root = await mkdtemp(join(tmpdir(), 'acp-launch-test-'));
      roots.push(root);
      const capture = join(root, 'capture.json');
      const peer = fileURLToPath(new URL('./fixtures/launch-config-agent.ts', import.meta.url));
      const start = ACPSession.start({
        command: process.execPath,
        args: [peer],
        projectRoot: root,
        role: 'copilot',
        mcpServers: servers,
        env: { ACP_LAUNCH_CAPTURE: capture, ACP_FAIL_INIT: fail ? '1' : '0' },
        timeoutMs: 10000,
      });
      if (fail) await expect(start).rejects.toThrow('fixture initialization failure');
      else {
        const session = await start;
        const received = JSON.parse(await readFile(capture, 'utf8'));
        expect(existsSync(received.configFile)).toBe(true);
        await session.close();
      }
      const received = JSON.parse(await readFile(capture, 'utf8'));
      expect(received.config.mcpServers['wrongstack-mailbox'].args).toContain('--actor=worker-a');
      expect(existsSync(received.configFile)).toBe(false);
    },
  );

  it('registers the exact Pi session servers using the supported native extension API', () => {
    const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
    registerPiMcpServers(
      { registerMcpServer: (name, config) => calls.push({ name, config }) },
      servers,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: 'wrongstack-mailbox',
      config: {
        type: 'stdio',
        args: ['mcp', 'serve', 'mailbox', '--actor=worker-a', '--session-id=owner'],
        env: { MODE: 'test' },
        exposure: 'deferred',
        toolExposure: { mailbox_read: 'direct' },
      },
    });
    expect(calls[1]).toMatchObject({
      name: 'fleet',
      config: { type: 'http', headers: { Authorization: 'Bearer fixture-value' } },
    });
  });
});
