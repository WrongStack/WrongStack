import type { runOneAcpTask } from '@wrongstack/acp';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  Config,
  ConfigStore,
  Message,
  PermissionPolicy,
  Provider,
  SessionBranchDescriptor,
  SessionStore,
  SessionWriter,
  Tool,
} from '@wrongstack/contracts/types';
import type { ExtensionRegistryPort } from '@wrongstack/contracts/types/extension-points';
import type { DispatchClassifier, FleetSupervisor } from '@wrongstack/coordination';
import type { PluginUiRegistry } from '@wrongstack/core/plugin';
import type { SessionTreeCoordinator } from '@wrongstack/core/storage';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { TuneupUpdateInfo } from './tuneup-types.js';

export interface CommandSessionContext {
  session?: { id?: string | undefined } | undefined;
  messages?: Message[] | undefined;
  state?:
    | {
        replaceMessages(messages: Message[]): void;
      }
    | undefined;
}

/**
 * What the portable slash commands need from the process running them. The TUI passes its
 * whole command context, which has every field; an engine without a terminal passes these.
 */
export interface SessionCommandHost {
  sessionStore?: SessionStore | undefined;
  sessionRef?: { current?: SessionWriter | undefined } | undefined;
  context?: CommandSessionContext | undefined;
  paths?: WstackPaths | undefined;
  events?: EventBus | undefined;
  extensionRegistry?: ExtensionRegistryPort | undefined;
  treeCoordinator?: SessionTreeCoordinator | (() => SessionTreeCoordinator | undefined) | undefined;
  onTreeMessagesReplaced?:
    | ((messages: Message[], branch: SessionBranchDescriptor) => void)
    | undefined;
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

/** Host surface accepted by `/tree` (allows omitting `projectRoot` in standalone tests). */
export interface TreeCommandHost extends SessionCommandHost {
  projectRoot?: string | undefined;
}

/** Where a command reports progress while it runs, besides its returned message. */
export interface CommandNotices {
  write(text: string): void;
  writeInfo(text: string): void;
  writeWarning(text: string): void;
}

/** What `/spawn` sets on the worker it starts. */
export interface SpawnCommandOptions {
  provider?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  name?: string | undefined;
  /** The conversation that asked; its roster gets the worker. */
  originSessionId?: string | undefined;
}

/**
 * The fleet commands' host: how a worker is started, how the Director comes up and where the
 * fleet supervisor is. A host without a fleet leaves the callbacks out and the commands say so.
 */
export interface FleetCommandHost {
  renderer: CommandNotices;
  /** Starts a worker on a task and returns a one-line summary. */
  onSpawn?: ((description: string, opts?: SpawnCommandOptions) => Promise<string>) | undefined;
  /** Starts a worker in a roster role and returns its id. */
  onFleetSpawn?: ((role: string, originSessionId?: string) => Promise<string>) | undefined;
  /** The model that picks a role when the keyword heuristic is unsure. */
  onDispatchClassify?: DispatchClassifier | undefined;
  /** Brings the Director up; null when it cannot. */
  onDirector?: (() => Promise<string | null>) | undefined;
  /** The running fleet supervisor, if any. */
  getFleetSupervisor?: (() => FleetSupervisor | null) | undefined;
}

/** What `/acp` hands an agent so it can reach WrongStack (`acp.bridge` config). */
type AcpSessionSetup = Parameters<typeof runOneAcpTask>[0]['sessionSetup'];
type AcpBridgeConfig = NonNullable<Config['acp']>['bridge'];

/** `/acp` and `/ensemble`: the external ACP agents installed on this machine. */
export interface AcpCommandHost {
  renderer: CommandNotices;
  projectRoot: string;
  cwd: string;
  /** The user config: `acp.agents` command overrides and the `acp.bridge` setup. */
  configStore?: ConfigStore | undefined;
  /** The profile paths; the synced ACP registry snapshot is cached under them. */
  paths?: WstackPaths | undefined;
  /** Runs `--bg` tasks as fleet subagents. */
  onSpawn?: FleetCommandHost['onSpawn'];
  /** Hands an agent WrongStack's tools; absent, the agent works on its own. */
  acpSessionSetup?:
    | ((
        agentId: string,
        projectRoot: string,
        bridge: AcpBridgeConfig | undefined,
      ) => AcpSessionSetup)
    | undefined;
  /** False where no terminal shows a running agent's progress: tasks run in the fleet. */
  inlineAcpRuns?: boolean | undefined;
}

/** What only the TUI's process has for /tuneup: its version check, config doctor and history. */
export interface TuneupHooks {
  checkForUpdate?: (() => Promise<TuneupUpdateInfo | undefined>) | undefined;
  /** How many problems the config doctor finds in a profile config. */
  countConfigIssues?: ((config: Record<string, unknown>) => number) | undefined;
  /** Records a config change in the config history. */
  appendConfigHistory?:
    | ((
        before: Record<string, unknown>,
        after: Record<string, unknown>,
        reason: string,
        file: string,
      ) => Promise<unknown>)
    | undefined;
}

/** `/tuneup`: the config it checks and fixes, and what the session has loaded. */
export interface TuneupCommandHost extends TuneupHooks {
  projectRoot: string;
  configStore?: ConfigStore | undefined;
  paths?: WstackPaths | undefined;
  /** The active profile's config file, which the fixes are written to. */
  getProfileConfigPath?: (() => string | undefined) | undefined;
  skillLoader?:
    | {
        list(): Promise<Array<{ name: string; source: string }>>;
        readBody(name: string): Promise<string>;
      }
    | undefined;
  mcpStatus?:
    | (() => Array<{ name: string; state: string; enabled: boolean; toolCount: number }>)
    | undefined;
  /** Asks about one fix (`--pick`); absent where nothing can ask. */
  confirm?: ((question: string, defaultYes?: boolean) => Promise<boolean | null>) | undefined;
  /** Applies the fixes' YOLO and autonomy changes to the running session. */
  onYolo?: ((setTo?: boolean) => unknown) | undefined;
  onAutonomy?: ((setTo?: 'auto') => unknown) | undefined;
}

export interface InitCommandHost {
  projectRoot: string;
  renderer: CommandNotices;
}

/** The Git commands: the repository, and the model that drafts a commit message. */
export interface GitCommandHost {
  cwd: string;
  projectRoot: string;
  /** The conversation whose id a commit-safety check records. */
  context?: CommandSessionContext | undefined;
  llmProvider?: Provider | undefined;
  llmModel?: string | undefined;
}

/** /gitid: the live config, and how the active profile's config file is written. */
export interface GitIdCommandHost {
  configStore?: ConfigStore | undefined;
  /** Changes the active profile's config file; undefined when this host cannot write it. */
  patchProfileConfig?:
    | ((mutate: (config: Record<string, unknown>) => void) => Promise<unknown>)
    | undefined;
}

/** `/permissions`: the policy whose rules it lists and explains, and the tools it names. */
export interface PermissionsCommandHost {
  permissionPolicy?:
    | (Pick<PermissionPolicy, 'listRules' | 'explain'> & {
        getYolo?: (() => boolean) | undefined;
      })
    | undefined;
  toolRegistry?: { get(name: string): Tool | undefined } | undefined;
}

/** `/plugin`: the profile config it writes and how the running engine takes the change. */
export interface PluginManagementCommandHost {
  configStore?: ConfigStore | undefined;
  getProfileConfigPath?: (() => string | undefined) | undefined;
  paths?: WstackPaths | undefined;
  projectRoot?: string | undefined;
  /** Back the profile config up before a write. */
  backupConfig?: ((configPath: string) => Promise<void>) | undefined;
  /** Apply the written change to the live config (default: `configStore.update`). */
  applyConfigPatch?: ((patch: Partial<Config>) => void) | undefined;
  /** Hot-reload external plugins in the running session without restarting. */
  reloadPlugins?:
    | ((name?: string) => Promise<{ reloaded: string[]; unloaded: string[]; failed: string[] }>)
    | undefined;
  /** Declarative `api.ui` slot registry owned by the live plugin host (used by `/panel`). */
  pluginUiRegistry?: PluginUiRegistry | (() => PluginUiRegistry | undefined) | undefined;
  /** Optional shared developer watch controller for `/plugin watch <name|off>`. */
  pluginWatchController?:
    | import('../plugin-management/plugin-watch.js').PluginDevWatchController
    | undefined;
}

export interface PortableCommandHost
  extends SessionCommandHost,
    PermissionsCommandHost,
    Omit<PluginManagementCommandHost, 'projectRoot'>,
    InitCommandHost,
    GitCommandHost,
    GitIdCommandHost,
    FleetCommandHost,
    AcpCommandHost,
    TuneupCommandHost {}
