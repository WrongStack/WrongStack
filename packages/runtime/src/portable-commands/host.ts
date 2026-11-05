import type { runOneAcpTask } from '@wrongstack/acp';
import type { Config, ConfigStore, Provider, SessionStore } from '@wrongstack/contracts/types';
import type { DispatchClassifier, FleetSupervisor } from '@wrongstack/coordination';
import type { WstackPaths } from '@wrongstack/core/utils';

/**
 * What the portable slash commands need from the process running them. The TUI passes its
 * whole command context, which has every field; an engine without a terminal passes these.
 */
export interface SessionCommandHost {
  sessionStore?: SessionStore | undefined;
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

export interface InitCommandHost {
  projectRoot: string;
  renderer: CommandNotices;
}

/** The Git commands: the repository, and the model that drafts a commit message. */
export interface GitCommandHost {
  cwd: string;
  projectRoot: string;
  /** The conversation whose id a commit-safety check records. */
  context?: { session?: { id?: string | undefined } | undefined } | undefined;
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

export interface PortableCommandHost
  extends SessionCommandHost,
    InitCommandHost,
    GitCommandHost,
    GitIdCommandHost,
    FleetCommandHost,
    AcpCommandHost {}
