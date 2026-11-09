import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrongstackBridgeSetup } from '@wrongstack/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAcpCommand } from '../../runtime/src/portable-commands/acp.js';
import type { AcpCommandHost } from '../../runtime/src/portable-commands/host.js';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';
import { parallelACPAgents, spawnACPAgent } from '../src/subcommands/handlers/acp-agents.js';

const roots: string[] = [];
const peers = new Set<number>();
afterEach(async () => {
  // Transport stop requests are synchronous; wait for their real peer processes to exit.
  for (const pid of peers) {
    await vi.waitFor(
      () => {
        let running = false;
        try {
          process.kill(pid, 0);
          running = true;
        } catch {}
        expect(running).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
  }
  peers.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function fixture(servers: string[] = ['kanban']) {
  const root = await mkdtemp(join(tmpdir(), 'wstack-acp-launch-context-'));
  roots.push(root);
  // A stable, read-only project directory avoids Windows retaining a temporary cwd handle.
  const projectRoot = fileURLToPath(new URL('./fixtures', import.meta.url));
  const capture = join(root, 'capture.json');
  const peer = fileURLToPath(new URL('./fixtures/acp-context-peer.ts', import.meta.url));
  const config = {
    acp: {
      agents: {
        'context-peer': {
          command: process.execPath,
          args: [peer],
          env: { ACP_CONTEXT_CAPTURE: capture },
        },
      },
      bridge: { agents: ['context-peer'], servers },
    },
  };
  const output: string[] = [];
  const renderer = {
    write: (s: string) => output.push(s),
    writeInfo: () => {},
    writeWarning: () => {},
    writeError: (s: string) => output.push(s),
  };
  const received = async () => {
    const record = JSON.parse(await readFile(capture, 'utf8')) as {
      pid: number;
      spawnCwd: string;
      params: { cwd: string; mcpServers: Array<{ name: string; args: string[] }> };
    };
    peers.add(record.pid);
    return record;
  };
  return { root, projectRoot, capture, config, renderer, received, output };
}

describe('parallel ACP launch context through real stdio peers', () => {
  it('gives CLI parallel workers the same project and MCP service as a single worker', async () => {
    const f = await fixture();
    const deps = {
      config: f.config,
      renderer: f.renderer,
      cwd: f.root,
      projectRoot: f.projectRoot,
    } as unknown as SubcommandDeps;
    expect(await spawnACPAgent(['context-peer', 'control'], deps)).toBe(0);
    const control = await f.received();
    expect(control.params.mcpServers[0]?.name).toBe('wrongstack-kanban');
    expect(control.spawnCwd).toBe(f.projectRoot);
    await unlink(f.capture);
    expect(await parallelACPAgents(['context-peer', 'parallel'], deps)).toBe(0);
    const parallel = await f.received();
    expect(parallel.params.mcpServers).toEqual(control.params.mcpServers);
    expect(parallel.params.cwd).toBe(f.projectRoot);
    expect(parallel.spawnCwd).toBe(f.projectRoot);
    expect(f.output.join('')).toContain('ACP_CONTEXT_PEER_OK');
  });

  it('gives inline /acp parallel workers the configured project bridge', async () => {
    const f = await fixture();
    const command = buildAcpCommand({
      renderer: f.renderer,
      cwd: f.projectRoot,
      projectRoot: f.projectRoot,
      configStore: { get: () => f.config },
      acpSessionSetup: wrongstackBridgeSetup,
    } as unknown as AcpCommandHost);
    await command.run('context-peer control', undefined as never);
    const control = await f.received();
    expect(control.params.mcpServers[0]?.name).toBe('wrongstack-kanban');
    await unlink(f.capture);
    const result = await command.run('parallel context-peer verify', undefined as never);
    const parallel = await f.received();
    expect(parallel.params.mcpServers).toEqual(control.params.mcpServers);
    expect(parallel.params.cwd).toBe(f.projectRoot);
    expect(parallel.spawnCwd).toBe(f.projectRoot);
    expect(result?.message).toContain('ACP_CONTEXT_PEER_OK');
  });

  it('keeps an explicitly disabled bridge off while retaining the project root', async () => {
    const f = await fixture([]);
    const deps = {
      config: f.config,
      renderer: f.renderer,
      cwd: f.root,
      projectRoot: f.projectRoot,
    } as unknown as SubcommandDeps;
    expect(await parallelACPAgents(['context-peer', 'no services'], deps)).toBe(0);
    const parallel = await f.received();
    expect(parallel.params.mcpServers).toEqual([]);
    expect(parallel.params.cwd).toBe(f.projectRoot);
    expect(parallel.spawnCwd).toBe(f.projectRoot);
  });
});
