/**
 * WrongStack's slash commands for an editor connected over ACP: the portable
 * commands (`@wrongstack/runtime/commands`) and the builtin plugins' commands,
 * advertised with `available_commands_update` and run when a prompt names one.
 *
 * The command set is built per ACP session, bound to that session's agent:
 * several commands read their host's conversation, provider and model, and an
 * ACP server runs several sessions at once. The commands that start fleet
 * workers are left out, as this host runs no fleet. A command that changes or
 * deletes something is first put to the user through `session/request_permission`.
 */
import type { AvailableCommand, RunTurnApi } from '@wrongstack/acp/agent';
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { stripAnsi, toErrorMessage, type WstackPaths } from '@wrongstack/core/utils';
import { getActiveFleetSupervisor, wrongstackBridgeSetup } from '@wrongstack/fleet';
import {
  buildPluginCommands,
  buildPortableCommands,
  type PluginCommandHost,
  type PortableCommandHost,
} from '@wrongstack/runtime/commands';

/** Commands that start fleet workers; this host has no fleet to start them in. */
const NEEDS_FLEET = new Set(['spawn', 'delegate', 'director', 'supervisor', 'ensemble']);
/** Commands that change or delete something; the user approves each run. */
const DESTRUCTIVE = new Set([
  'prune',
  'push',
  'commit',
  'init',
  'skill-install',
  'skill-import',
  'skill-update',
  'skill-uninstall',
  'sync',
]);

type CommandContext = Parameters<SlashCommand['run']>[1];

export interface AcpServerCommandsDeps {
  paths?: WstackPaths | undefined;
  vault?: PluginCommandHost['vault'];
  projectRoot: string;
}

export interface AcpServerCommands {
  /** What `available_commands_update` lists. */
  list(): Promise<AvailableCommand[]>;
  /** `ACPServerAgentTurnOptions.runCommand`. */
  run(
    agent: Agent,
    sessionId: string,
    command: { name: string; args: string },
    turn: { signal: AbortSignal; api?: RunTurnApi | undefined; emit: (update: unknown) => void },
  ): Promise<{ message: string; runText?: string } | undefined>;
  /** Forget a closed session's command set. */
  dispose(sessionId: string): void;
}

export function createAcpServerCommands(deps: AcpServerCommandsDeps): AcpServerCommands {
  const sessions = new Map<string, { agent: Agent; commands: Promise<SlashCommand[]> }>();
  let listed: Promise<AvailableCommand[]> | undefined;

  const commandsFor = (sessionId: string, agent: Agent): Promise<SlashCommand[]> => {
    const known = sessions.get(sessionId);
    if (known && known.agent === agent) return known.commands;
    const commands = buildCommands(hostFor(agent, deps), agent, deps);
    sessions.set(sessionId, { agent, commands });
    return commands;
  };

  return {
    list: () =>
      (listed ??= buildCommands(hostFor(undefined, deps), undefined, deps)
        .then((commands) => commands.map(availableCommand))
        .catch(() => {
          listed = undefined;
          return [];
        })),
    async run(agent, sessionId, { name, args }, turn) {
      const command = find(await commandsFor(sessionId, agent), name);
      if (!command) return undefined;
      if (DESTRUCTIVE.has(command.name) && !(await approved(command, args, turn))) {
        return { message: `/${command.name} was not run: the request was rejected.` };
      }
      try {
        const result = await command.run(args, agent.ctx as CommandContext);
        return {
          message: stripAnsi(result?.message ?? ''),
          ...(result?.runText ? { runText: result.runText } : {}),
        };
      } catch (err) {
        return { message: `/${command.name} failed: ${toErrorMessage(err)}` };
      }
    },
    dispose(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

function find(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  return commands.find((command) => command.name === name);
}

function availableCommand(command: SlashCommand): AvailableCommand {
  return {
    name: command.name,
    description: command.description,
    ...(command.argsHint ? { input: { hint: command.argsHint } } : {}),
  };
}

/**
 * Ask before a command that changes or deletes something. The request names a
 * tool call the client has just been told about, which is how editors render
 * a permission question; it is closed with the user's answer either way.
 */
async function approved(
  command: SlashCommand,
  args: string,
  turn: { api?: RunTurnApi | undefined; emit: (update: unknown) => void },
): Promise<boolean> {
  if (!turn.api) return false;
  const toolCallId = `cmd_${command.name}_${Date.now()}`;
  const title = `/${command.name}${args ? ` ${args}` : ''}`;
  turn.emit({ sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'pending' });
  let allowed = false;
  try {
    const outcome = await turn.api.requestPermission({
      toolCall: { toolCallId, title, kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: 'Run', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Cancel', kind: 'reject_once' },
      ],
    });
    allowed = outcome.outcome === 'selected' && outcome.optionId.startsWith('allow');
  } catch {
    allowed = false;
  }
  turn.emit({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: allowed ? 'completed' : 'failed',
  });
  return allowed;
}

/** A portable-command host bound to one session's agent, or to none for the listing. */
function hostFor(agent: Agent | undefined, deps: AcpServerCommandsDeps): PortableCommandHost {
  const container = agent?.container;
  const ctx = agent?.ctx;
  const projectRoot = () => (ctx?.projectRoot as string | undefined) ?? deps.projectRoot;
  return {
    get sessionStore() {
      return container?.safeResolve(TOKENS.SessionStore);
    },
    get projectRoot() {
      return projectRoot();
    },
    get cwd() {
      return projectRoot();
    },
    get context() {
      return ctx;
    },
    get llmProvider() {
      return ctx?.provider;
    },
    get llmModel() {
      return ctx?.model;
    },
    get configStore() {
      return container?.safeResolve(TOKENS.ConfigStore);
    },
    getFleetSupervisor: getActiveFleetSupervisor,
    get permissionPolicy() {
      return agent?.permission;
    },
    get toolRegistry() {
      return agent?.tools;
    },
    get paths() {
      return deps.paths;
    },
    get skillLoader() {
      return container?.safeResolve(TOKENS.SkillLoader);
    },
    acpSessionSetup: wrongstackBridgeSetup,
    inlineAcpRuns: false,
    renderer: { write() {}, writeInfo() {}, writeWarning() {} },
  } as PortableCommandHost;
}

/** The portable commands this host can run, then the plugins' commands under still-free names. */
async function buildCommands(
  host: PortableCommandHost,
  agent: Agent | undefined,
  deps: AcpServerCommandsDeps,
): Promise<SlashCommand[]> {
  const own = buildPortableCommands(host).filter((command) => !NEEDS_FLEET.has(command.name));
  const taken = new Set(own.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const plugins = await buildPluginCommands({
    skillLoader: agent?.container.safeResolve(TOKENS.SkillLoader),
    paths: deps.paths,
    configStore: agent?.container.safeResolve(TOKENS.ConfigStore),
    vault: deps.vault,
  } as PluginCommandHost).catch(() => []);
  return [...own, ...plugins.filter((command) => !taken.has(command.name))];
}
