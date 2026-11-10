/**
 * An ACP agent (Claude Code, through the user's own install) as the leader of
 * a standalone-engine conversation — `provider: "acp"`, `model: "claude-code"`
 * — and the machine's WrongForge the same way (`provider: "wrongforge"`),
 * exactly as the CLI runs them (wiring/provider.ts registers the factory,
 * wiring/lifecycle-plugins.ts binds the host, webui-server.ts resolves each
 * tab's agent, cli-entry-point.ts closes the agent sessions on exit).
 *
 * Without this the engine behind WebUI/desktop had no `acp` or `wrongforge`
 * factory: a profile whose provider was either failed to boot ("needs an
 * explicit family"), and the pickers never offered them.
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Provider } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  type AcpLeaderHost,
  type AcpLeaderSessionAgent,
  acpLeaderHost,
  acpLeaderPickable,
  bindAcpLeaderHost,
  closeAcpLeaderSessions,
  confirmAcpLeaderThroughEvents,
  createAcpLeaderHost,
  createAcpLeaderProviderFactory,
  setAcpLeaderSessionAgents,
} from '@wrongstack/runtime/acp-leader';
import { drainRemoteWork } from '@wrongstack/runtime/acp-leader-host';
import {
  createWrongForgeLeaderProviderFactory,
  wrongForgeLeaderPickable,
} from '@wrongstack/runtime/wrongforge-leader';
import type { HostProvider } from './provider/host-providers.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';

/**
 * Register the agent leader factories (ACP, WrongForge). Each is inert unless
 * the conversation names it; their side requests (titles, summaries, the
 * refiner, WrongStack subagents) go to `acp.leader.sideModel`, built here the
 * way a model switch builds one.
 */
export function registerStandaloneAcpLeaderProvider(
  providerRegistry: ProviderRegistry,
  bootConfig: Config,
): void {
  const buildProvider = (providerId: string, live: Config) =>
    buildSideProvider(providerRegistry, live, providerId);
  providerRegistry.register(createAcpLeaderProviderFactory({ bootConfig, buildProvider }));
  providerRegistry.register(createWrongForgeLeaderProviderFactory({ bootConfig, buildProvider }));
}

/**
 * The providers this engine serves itself, listed beside the saved ones in the
 * pickers: `acp` with one model per ACP agent installed here, and `wrongforge`
 * with the models the machine's WrongForge serves (none set up → no row).
 */
export function standaloneHostProviders(config: Config | undefined): HostProvider[] {
  return [...acpLeaderPickable(config), ...wrongForgeLeaderPickable()];
}

/** A side model's provider: its saved entry, through WrongProxy when that is on. */
function buildSideProvider(
  providerRegistry: ProviderRegistry,
  config: Config,
  providerId: string,
): Provider {
  const saved = config.providers?.[providerId] ?? { type: providerId };
  const factoryType = saved.type ?? providerId;
  // The legacy top-level baseUrl belongs to the primary — the ACP leader here.
  const routed = routeProviderCfgThroughProxy(saved, undefined, providerId);
  return providerRegistry.has(factoryType)
    ? providerRegistry.create({ ...routed, type: providerId } as never, factoryType)
    : makeProviderFromConfig(providerId, { ...routed, type: factoryType });
}

export interface StandaloneAcpLeaderHostInput {
  /** The engine's leader agent: the one serving a session no tab agent runs. */
  agent: Agent;
  events: EventBus;
  projectRoot: string;
  /** The project's state directory: an agent session is remembered there for resume. */
  stateDir: string;
  getConfig(): Config;
  toolRegistry: Pick<ToolRegistry, 'get' | 'list'>;
  /** Each tab's own agent, without creating one. */
  peekAgent(sessionId: string): AcpLeaderSessionAgent | undefined;
}

export interface StandaloneAcpLeaderHost {
  /** Close every live agent session, let task cancellations finish and unbind (engine shutdown). */
  dispose(): Promise<void>;
}

/**
 * Bind the host services the leader provider reads: the agent's event bus for
 * tool cards, each tab's permission policy and context, the leader tools it
 * reaches over MCP, and the state directory for resume. The engine answers
 * confirmations itself (its clients get `tool.confirm_needed`), so the agent's
 * permission requests are asked that way, never on a terminal prompt.
 */
export function bindStandaloneAcpLeaderHost(
  input: StandaloneAcpLeaderHostInput,
): StandaloneAcpLeaderHost {
  bindAcpLeaderHost(
    createAcpLeaderHost({
      agent: input.agent,
      events: input.events,
      projectRoot: input.projectRoot,
      stateDir: input.stateDir,
      getConfig: input.getConfig,
      getTool: (name) => input.toolRegistry.get(name),
      listTools: () => input.toolRegistry.list(),
      confirmAwaiter: undefined,
    }),
  );
  confirmAcpLeaderThroughEvents();
  const bound: AcpLeaderHost | undefined = acpLeaderHost();
  const resolveSession = (sessionId: string) => input.peekAgent(sessionId);
  setAcpLeaderSessionAgents(resolveSession);
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      await closeAcpLeaderSessions();
      // A WrongForge turn cut off by the shutdown cancels its task over HTTP.
      await drainRemoteWork();
      // Another host bound in this process since (tests start several): leave it.
      if (acpLeaderHost() === bound) {
        bindAcpLeaderHost(undefined);
        setAcpLeaderSessionAgents(undefined);
      }
    },
  };
}
