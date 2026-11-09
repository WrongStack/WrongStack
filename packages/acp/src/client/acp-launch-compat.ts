import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '../types/acp-v1.js';
import type { ACPSessionOptions } from './acp-session-types.js';

export interface PreparedAcpLaunch {
  args: string[];
  env: Record<string, string> | undefined;
  dispose(): Promise<void>;
}

export function copilotMcpConfig(servers: McpServer[]): Record<string, unknown> {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        'command' in server
          ? {
              type: 'local',
              command: server.command,
              args: server.args ?? [],
              env: Object.fromEntries((server.env ?? []).map((x) => [x.name, x.value])),
              tools: ['*'],
            }
          : {
              type: server.type,
              url: server.url,
              headers: Object.fromEntries((server.headers ?? []).map((x) => [x.name, x.value])),
              tools: ['*'],
            },
      ]),
    ),
  };
}

/** Preserve per-task identity when an ACP adapter needs native startup configuration. */
export function prepareAcpLaunch(
  opts: ACPSessionOptions,
): PreparedAcpLaunch | Promise<PreparedAcpLaunch> {
  const args = [...(opts.args ?? [])];
  let env = opts.env;
  let directory: string | undefined;
  const prepared: PreparedAcpLaunch = {
    args,
    env,
    async dispose() {
      const owned = directory;
      directory = undefined;
      if (owned) await rm(owned, { recursive: true, force: true });
    },
  };
  if (opts.mcpServers?.length && ['copilot', 'github-copilot-cli'].includes(opts.role ?? '')) {
    const servers = opts.mcpServers;
    return (async () => {
      directory = await mkdtemp(join(tmpdir(), 'wrongstack-copilot-mcp-'));
      const file = join(directory, 'mcp.json');
      try {
        await writeFile(file, JSON.stringify(copilotMcpConfig(servers)), { mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      args.push('--additional-mcp-config', `@${file}`);
      return prepared;
    })();
  }
  if (opts.mcpServers?.length && opts.role === 'pi-acp' && opts.env?.WRONGSTACK_PI_MCP_EXTENSION) {
    env = { ...opts.env, WRONGSTACK_PI_SESSION_MCP: JSON.stringify(opts.mcpServers) };
    prepared.env = env;
  }
  return prepared;
}
