/**
 * The tool gateway a WrongForge worker calls back into: the same REST surface
 * as `wstack tools serve`, started in-process on a loopback port the first
 * time a WrongForge task runs, one per project, for the life of the process.
 *
 * Worker level: every capability, under the guards WrongStack's own subagents
 * answer to (user deny rules, credential reads, git history, outside-project
 * deletion; YOLO+ from the live config). The runner turns WrongForge's own
 * write and shell tools off, so its edits and commands run here, inside
 * WrongStack's rules, next to the code index and the board.
 */
import { randomBytes } from 'node:crypto';
import type { Config } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { createToolGateway, resolveGatewayRegistry } from '../tool-gateway.js';
import { serveToolGatewayHttp } from '../tool-gateway-http.js';
import type { WrongForgeGatewaySpec } from './wrongforge-client.js';

/**
 * WrongForge keeps its own read-side tools (the runner allows them); a second
 * copy only splits the model's choice.
 */
const DUPLICATES_OF_WRONGFORGE_TOOLS = [
  'read',
  'glob',
  'grep',
  'fetch',
  'read_url_content',
  'tree',
];

/**
 * Never served to a worker: steering the fleet and the leader's session is the
 * leader's job. A worker that could `delegate` would spawn workers of its own,
 * filed under a session nobody is in (the gateway has no session). Memory,
 * mailbox and the board stay: those are how a worker shares what it learns.
 */
export const WORKER_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  'delegate',
  'spawn_subagent',
  'define_subagent',
  'assign_task',
  'await_tasks',
  'roll_up',
  'ask_subagent',
  'ask_result',
  'fleet',
  'fleet_status',
  'fleet_emit',
  'session_note',
  'session_rename',
  'terminate_subagent',
  'terminate_all',
  'work_complete',
  'nextsteps',
  'collab_debug',
  'plugin_manager',
  'mcp_control',
]);

interface GatewayOptions {
  projectRoot: string;
  registry: ToolRegistry;
  config: Config;
  yoloPlus?: (() => boolean) | undefined;
  log?: ((message: string) => void) | undefined;
}

const gateways = new Map<string, Promise<WrongForgeGatewaySpec>>();

export function sharedWrongForgeGateway(opts: GatewayOptions): Promise<WrongForgeGatewaySpec> {
  const existing = gateways.get(opts.projectRoot);
  if (existing) return existing;
  const started = startGateway(opts);
  gateways.set(opts.projectRoot, started);
  // A failed start is retried by the next task rather than cached.
  started.catch(() => {
    if (gateways.get(opts.projectRoot) === started) gateways.delete(opts.projectRoot);
  });
  return started;
}

async function startGateway(opts: GatewayOptions): Promise<WrongForgeGatewaySpec> {
  const registry = resolveGatewayRegistry(opts.registry, opts.config);
  const gateway = await createToolGateway({
    registry,
    config: opts.config,
    cwd: opts.projectRoot,
    projectRoot: opts.projectRoot,
    yolo: true,
    ...(opts.yoloPlus ? { yoloPlus: opts.yoloPlus } : {}),
    whitelist: new Set(
      registry
        .list()
        .map((t) => t.name)
        .filter((name) => !WORKER_WITHHELD_TOOLS.has(name)),
    ),
    remoteAgent: true,
    ...(opts.log ? { onWarning: opts.log } : {}),
  });
  const token = randomBytes(24).toString('hex');
  const handle = await serveToolGatewayHttp({
    gateway,
    registry,
    token,
    port: 0,
    host: '127.0.0.1',
    unref: true,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return {
    url: handle.url.replace(/\/+$/, ''),
    token,
    list_path: '/v1/tools',
    call_path: '/v1/tools/{name}/call',
    name_prefix: 'wstack_',
    deny: DUPLICATES_OF_WRONGFORGE_TOOLS,
    optional: true,
  };
}
